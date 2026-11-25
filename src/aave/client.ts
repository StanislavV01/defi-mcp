import { getAddress, type Address } from "viem";
import { getClient, SUPPORTED_CHAINS, type ChainName } from "../chains.js";
import { bpsToFraction, fromUnits, oraclePriceToUsd, rayRateToApy, round, type SimPosition } from "../math.js";
import { addressesProviderAbi, dataProviderAbi, erc20Abi, oracleAbi, poolAbi } from "./abis.js";

interface AaveContracts {
  pool: Address;
  oracle: Address;
  dataProvider: Address;
}

export interface Market {
  symbol: string;
  address: Address;
  decimals: number;
  priceUsd: number;
  supplyApy: number;
  variableBorrowApy: number;
  ltv: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  totalSupplied: number;
  totalBorrowed: number;
  utilization: number;
  canBeCollateral: boolean;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
}

export interface UserReserve {
  symbol: string;
  address: Address;
  supplied: number;
  suppliedUsd: number;
  borrowed: number;
  borrowedUsd: number;
  usedAsCollateral: boolean;
  supplyApy: number;
  variableBorrowApy: number;
  liquidationThreshold: number;
  priceUsd: number;
}

export interface AccountSummary {
  chain: ChainName;
  user: Address;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  /** null when the account has no debt */
  healthFactor: number | null;
  currentLiquidationThreshold: number;
  ltv: number;
  eModeCategory: number;
  netApy: number | null;
  reserves: UserReserve[];
}

const contractsCache = new Map<ChainName, Promise<AaveContracts>>();
const MARKET_TTL_MS = 60_000;
const marketsCache = new Map<ChainName, { at: number; data: Promise<Market[]> }>();

export function getContracts(chain: ChainName): Promise<AaveContracts> {
  let p = contractsCache.get(chain);
  if (!p) {
    p = (async () => {
      const client = getClient(chain);
      const provider = SUPPORTED_CHAINS[chain].addressesProvider;
      const [pool, oracle, dataProvider] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: provider, abi: addressesProviderAbi, functionName: "getPool" },
          { address: provider, abi: addressesProviderAbi, functionName: "getPriceOracle" },
          { address: provider, abi: addressesProviderAbi, functionName: "getPoolDataProvider" },
        ],
      });
      return { pool, oracle, dataProvider };
    })();
    p.catch(() => contractsCache.delete(chain));
    contractsCache.set(chain, p);
  }
  return p;
}

export function getMarkets(chain: ChainName): Promise<Market[]> {
  const cached = marketsCache.get(chain);
  if (cached && Date.now() - cached.at < MARKET_TTL_MS) return cached.data;
  const data = loadMarkets(chain);
  data.catch(() => marketsCache.delete(chain));
  marketsCache.set(chain, { at: Date.now(), data });
  return data;
}

async function loadMarkets(chain: ChainName): Promise<Market[]> {
  const client = getClient(chain);
  const { oracle, dataProvider } = await getContracts(chain);

  const tokens = await client.readContract({
    address: dataProvider,
    abi: dataProviderAbi,
    functionName: "getAllReservesTokens",
  });
  const assets = tokens.map((t) => t.tokenAddress);

  const [prices, configs, reserves] = await Promise.all([
    client.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetsPrices", args: [assets] }),
    client.multicall({
      allowFailure: false,
      contracts: assets.map((a) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: "getReserveConfigurationData" as const,
        args: [a] as const,
      })),
    }),
    client.multicall({
      allowFailure: false,
      contracts: assets.map((a) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: "getReserveData" as const,
        args: [a] as const,
      })),
    }),
  ]);

  return tokens.map((t, i) => {
    const [decimalsRaw, ltv, lt, bonus, , canCollateral, borrowing, , active, frozen] = configs[i]!;
    const r = reserves[i]!;
    const decimals = Number(decimalsRaw);
    const totalSupplied = fromUnits(r[2], decimals);
    const totalBorrowed = fromUnits(r[3] + r[4], decimals);
    return {
      symbol: t.symbol,
      address: t.tokenAddress,
      decimals,
      priceUsd: oraclePriceToUsd(prices[i]!),
      supplyApy: round(rayRateToApy(r[5]), 6),
      variableBorrowApy: round(rayRateToApy(r[6]), 6),
      ltv: bpsToFraction(ltv),
      liquidationThreshold: bpsToFraction(lt),
      // stored as 10500 = 5% bonus
      liquidationBonus: bonus > 0n ? round(bpsToFraction(bonus) - 1, 4) : 0,
      totalSupplied,
      totalBorrowed,
      utilization: totalSupplied > 0 ? round(totalBorrowed / totalSupplied, 4) : 0,
      canBeCollateral: canCollateral && lt > 0n,
      borrowingEnabled: borrowing,
      isActive: active,
      isFrozen: frozen,
    };
  });
}

export async function getAccount(chain: ChainName, userInput: string): Promise<AccountSummary> {
  const user = getAddress(userInput);
  const client = getClient(chain);
  const { pool, dataProvider } = await getContracts(chain);
  const markets = await getMarkets(chain);

  const [accountData, eMode, ...userReserves] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: pool, abi: poolAbi, functionName: "getUserAccountData", args: [user] },
      { address: pool, abi: poolAbi, functionName: "getUserEMode", args: [user] },
      ...markets.map((m) => ({
        address: dataProvider,
        abi: dataProviderAbi,
        functionName: "getUserReserveData" as const,
        args: [m.address, user] as const,
      })),
    ],
  });

  const [collateralBase, debtBase, availableBase, currentLt, ltv, hfRaw] = accountData as unknown as readonly bigint[];

  const reserves: UserReserve[] = [];
  markets.forEach((m, i) => {
    const ur = userReserves[i] as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
    const supplied = fromUnits(ur[0], m.decimals);
    const borrowed = fromUnits(ur[1] + ur[2], m.decimals);
    if (supplied === 0 && borrowed === 0) return;
    reserves.push({
      symbol: m.symbol,
      address: m.address,
      supplied: round(supplied, 8),
      suppliedUsd: round(supplied * m.priceUsd, 2),
      borrowed: round(borrowed, 8),
      borrowedUsd: round(borrowed * m.priceUsd, 2),
      usedAsCollateral: ur[8],
      supplyApy: m.supplyApy,
      variableBorrowApy: m.variableBorrowApy,
      liquidationThreshold: m.liquidationThreshold,
      priceUsd: m.priceUsd,
    });
  });

  const totalCollateralUsd = oraclePriceToUsd(collateralBase);
  const totalDebtUsd = oraclePriceToUsd(debtBase);
  const supplyIncome = reserves.reduce((s, r) => s + r.suppliedUsd * r.supplyApy, 0);
  const borrowCost = reserves.reduce((s, r) => s + r.borrowedUsd * r.variableBorrowApy, 0);
  const suppliedUsd = reserves.reduce((s, r) => s + r.suppliedUsd, 0);
  const netWorth = suppliedUsd - totalDebtUsd;

  return {
    chain,
    user,
    totalCollateralUsd: round(totalCollateralUsd, 2),
    totalDebtUsd: round(totalDebtUsd, 2),
    availableBorrowsUsd: round(oraclePriceToUsd(availableBase), 2),
    healthFactor: debtBase === 0n ? null : round(fromUnits(hfRaw, 18), 4),
    currentLiquidationThreshold: bpsToFraction(currentLt),
    ltv: bpsToFraction(ltv),
    eModeCategory: Number(eMode),
    netApy: netWorth > 0 ? round((supplyIncome - borrowCost) / netWorth, 6) : null,
    reserves,
  };
}

export async function getWalletBalances(chain: ChainName, userInput: string) {
  const user = getAddress(userInput);
  const client = getClient(chain);
  const markets = await getMarkets(chain);
  const [native, balances] = await Promise.all([
    client.getBalance({ address: user }),
    client.multicall({
      allowFailure: true,
      contracts: markets.map((m) => ({ address: m.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [user] as const })),
    }),
  ]);

  const nativeCurrency = SUPPORTED_CHAINS[chain].chain.nativeCurrency;
  const tokens = markets
    .map((m, i) => {
      const res = balances[i];
      if (!res || res.status !== "success") return null;
      const amount = fromUnits(res.result as bigint, m.decimals);
      if (amount === 0) return null;
      return { symbol: m.symbol, address: m.address, amount: round(amount, 8), usd: round(amount * m.priceUsd, 2) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.usd - a.usd);

  return {
    chain,
    user,
    native: { symbol: nativeCurrency.symbol, amount: round(fromUnits(native, nativeCurrency.decimals), 8) },
    tokens,
    note: "Only tokens listed as Aave V3 reserves on this chain are checked.",
  };
}

/** Convert an account into positions for the simulator. */
export function toSimPositions(account: AccountSummary): SimPosition[] {
  return account.reserves.map((r) => ({
    symbol: r.symbol,
    priceUsd: r.priceUsd,
    liquidationThreshold: r.liquidationThreshold,
    supplied: r.supplied,
    borrowed: r.borrowed,
    usedAsCollateral: r.usedAsCollateral,
  }));
}
