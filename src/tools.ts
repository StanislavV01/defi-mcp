import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAccount, getMarkets, getWalletBalances, toSimPositions } from "./aave/client.js";
import { CHAIN_NAMES } from "./chains.js";
import { applyAction, computeHealth, liquidationPriceDrop, round } from "./math.js";

const chain = z.enum(CHAIN_NAMES).default("base").describe(`Network: ${CHAIN_NAMES.join(", ")}`);
const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address")
  .describe("Wallet address (0x…)");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function riskLabel(hf: number | null): string {
  if (hf === null || !Number.isFinite(hf)) return "no debt";
  if (hf < 1) return "LIQUIDATABLE";
  if (hf < 1.1) return "critical";
  if (hf < 1.5) return "high risk";
  if (hf < 2) return "moderate";
  return "safe";
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "aave_markets",
    {
      title: "Aave V3 markets",
      description:
        "List Aave V3 reserves on a chain with price, supply/borrow APY, LTV, liquidation threshold and utilization. " +
        "Use to compare where to supply or borrow. APYs are fractions (0.05 = 5%).",
      inputSchema: {
        chain,
        symbols: z.array(z.string()).optional().describe("Only these symbols, e.g. ['USDC','WETH']"),
        sortBy: z.enum(["supplyApy", "variableBorrowApy", "totalSupplied", "symbol"]).default("totalSupplied"),
      },
    },
    async ({ chain, symbols, sortBy }) => {
      try {
        let markets = (await getMarkets(chain)).filter((m) => m.isActive);
        if (symbols?.length) {
          const wanted = new Set(symbols.map((s) => s.toLowerCase()));
          markets = markets.filter((m) => wanted.has(m.symbol.toLowerCase()));
        }
        markets.sort((a, b) =>
          sortBy === "symbol"
            ? a.symbol.localeCompare(b.symbol)
            : sortBy === "totalSupplied"
              ? b.totalSupplied * b.priceUsd - a.totalSupplied * a.priceUsd
              : b[sortBy] - a[sortBy],
        );
        return ok({ chain, count: markets.length, markets });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "aave_account",
    {
      title: "Aave V3 account",
      description:
        "Get a wallet's Aave V3 position: collateral, debt, health factor, risk level, net APY and per-asset breakdown. " +
        "Health factor < 1 means the position can be liquidated.",
      inputSchema: { chain, address },
    },
    async ({ chain, address }) => {
      try {
        const account = await getAccount(chain, address);
        const positions = toSimPositions(account);
        const liquidationDrops = account.reserves
          .filter((r) => r.usedAsCollateral && r.supplied > 0)
          .map((r) => {
            const d = liquidationPriceDrop(positions, r.symbol);
            return { symbol: r.symbol, priceDropToLiquidation: d === null ? null : round(d, 4) };
          });
        return ok({ ...account, risk: riskLabel(account.healthFactor), liquidationDrops });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "aave_simulate",
    {
      title: "Simulate Aave action",
      description:
        "What-if: estimate the health factor after a sequence of supply / withdraw / borrow / repay actions, " +
        "without sending any transaction. Use before recommending an action to the user. " +
        "Estimate ignores eMode and interest accrual; treat values close to 1 as unsafe.",
      inputSchema: {
        chain,
        address,
        actions: z
          .array(
            z.object({
              action: z.enum(["supply", "withdraw", "borrow", "repay"]),
              symbol: z.string().describe("Reserve symbol, e.g. USDC"),
              amount: z.number().positive().describe("Amount in token units, e.g. 100.5"),
            }),
          )
          .min(1)
          .max(10),
      },
    },
    async ({ chain, address, actions }) => {
      try {
        const [account, markets] = await Promise.all([getAccount(chain, address), getMarkets(chain)]);
        let positions = toSimPositions(account);
        const before = computeHealth(positions);
        const steps = [];
        for (const a of actions) {
          const m = markets.find((x) => x.symbol.toLowerCase() === a.symbol.toLowerCase());
          if (!m) throw new Error(`${a.symbol} is not an Aave reserve on ${chain}`);
          if (a.action === "borrow" && (!m.borrowingEnabled || m.isFrozen)) throw new Error(`${m.symbol} cannot be borrowed right now`);
          positions = applyAction(positions, a.action, m.symbol, a.amount, {
            symbol: m.symbol,
            priceUsd: m.priceUsd,
            liquidationThreshold: m.canBeCollateral ? m.liquidationThreshold : 0,
          });
          const h = computeHealth(positions);
          steps.push({ ...a, symbol: m.symbol, healthFactorAfter: fmtHf(h.healthFactor), risk: riskLabel(h.healthFactor) });
        }
        const after = computeHealth(positions);
        return ok({
          chain,
          user: account.user,
          before: { healthFactor: fmtHf(before.healthFactor), collateralUsd: round(before.collateralUsd, 2), debtUsd: round(before.debtUsd, 2) },
          after: { healthFactor: fmtHf(after.healthFactor), collateralUsd: round(after.collateralUsd, 2), debtUsd: round(after.debtUsd, 2) },
          risk: riskLabel(after.healthFactor),
          steps,
          warning: after.healthFactor < 1 ? "This sequence would make the position liquidatable — Aave would reject the borrow/withdraw." : undefined,
          note: "Estimate only. eMode, isolation mode and interest accrual are not modelled.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wallet_balances",
    {
      title: "Wallet balances",
      description: "Native and ERC-20 balances of a wallet (tokens that are Aave reserves on the chain), with USD values.",
      inputSchema: { chain, address },
    },
    async ({ chain, address }) => {
      try {
        return ok(await getWalletBalances(chain, address));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

function fmtHf(hf: number): number | null {
  return Number.isFinite(hf) ? round(hf, 4) : null;
}
