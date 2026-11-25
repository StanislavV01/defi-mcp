/**
 * Pure math helpers. No network, no viem — fully unit-testable.
 */

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/** Aave rates are per-year APR in ray (1e27). Convert to compounded APY as a fraction (0.05 = 5%). */
export function rayRateToApy(rateRay: bigint): number {
  const apr = Number((rateRay * 1_000_000n) / RAY) / 1_000_000;
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
}

/** Convert a raw token amount to a decimal number. */
export function fromUnits(amount: bigint, decimals: number): number {
  if (amount === 0n) return 0;
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  return Number(whole) + Number(frac) / Number(base);
}

/** Aave oracle prices are USD with 8 decimals. */
export function oraclePriceToUsd(price: bigint): number {
  return fromUnits(price, 8);
}

/** Basis points (e.g. 8250) to fraction (0.825). */
export function bpsToFraction(bps: bigint | number): number {
  return Number(bps) / 10_000;
}

export interface SimPosition {
  symbol: string;
  priceUsd: number;
  /** liquidation threshold as fraction, e.g. 0.825 */
  liquidationThreshold: number;
  supplied: number;
  borrowed: number;
  usedAsCollateral: boolean;
}

export interface HealthSummary {
  collateralUsd: number;
  debtUsd: number;
  /** Σ collateral_i × LT_i */
  weightedCollateralUsd: number;
  /** Infinity when there is no debt */
  healthFactor: number;
}

/**
 * Health factor = Σ(collateral_i × liquidationThreshold_i) / totalDebt.
 * Ignores eMode overrides — good enough for what-if estimates, and labelled as such.
 */
export function computeHealth(positions: SimPosition[]): HealthSummary {
  let collateralUsd = 0;
  let weightedCollateralUsd = 0;
  let debtUsd = 0;
  for (const p of positions) {
    const suppliedUsd = p.supplied * p.priceUsd;
    if (p.usedAsCollateral && p.liquidationThreshold > 0) {
      collateralUsd += suppliedUsd;
      weightedCollateralUsd += suppliedUsd * p.liquidationThreshold;
    }
    debtUsd += p.borrowed * p.priceUsd;
  }
  const healthFactor = debtUsd === 0 ? Infinity : weightedCollateralUsd / debtUsd;
  return { collateralUsd, debtUsd, weightedCollateralUsd, healthFactor };
}

export type SimAction = "supply" | "withdraw" | "borrow" | "repay";

/** Apply one action to a copy of the positions. Throws on impossible actions. */
export function applyAction(
  positions: SimPosition[],
  action: SimAction,
  symbol: string,
  amount: number,
  market?: Omit<SimPosition, "supplied" | "borrowed" | "usedAsCollateral">,
): SimPosition[] {
  if (!(amount > 0)) throw new Error("amount must be > 0");
  const next = positions.map((p) => ({ ...p }));
  const key = symbol.toLowerCase();
  let pos = next.find((p) => p.symbol.toLowerCase() === key);

  if (!pos) {
    if (!market) throw new Error(`Unknown asset ${symbol}`);
    pos = { ...market, supplied: 0, borrowed: 0, usedAsCollateral: market.liquidationThreshold > 0 };
    next.push(pos);
  }

  switch (action) {
    case "supply":
      pos.supplied += amount;
      break;
    case "withdraw":
      if (amount > pos.supplied + 1e-12) throw new Error(`Cannot withdraw ${amount} ${symbol}: only ${pos.supplied} supplied`);
      pos.supplied = Math.max(0, pos.supplied - amount);
      break;
    case "borrow":
      pos.borrowed += amount;
      break;
    case "repay":
      if (amount > pos.borrowed + 1e-12) throw new Error(`Cannot repay ${amount} ${symbol}: only ${pos.borrowed} borrowed`);
      pos.borrowed = Math.max(0, pos.borrowed - amount);
      break;
  }
  return next;
}

/** Price drop (fraction) of a collateral asset that would bring HF to 1. null if not applicable. */
export function liquidationPriceDrop(positions: SimPosition[], symbol: string): number | null {
  const h = computeHealth(positions);
  if (!Number.isFinite(h.healthFactor)) return null; // no debt
  if (h.healthFactor <= 1) return 0;
  const pos = positions.find((p) => p.symbol.toLowerCase() === symbol.toLowerCase());
  if (!pos || !pos.usedAsCollateral || pos.supplied === 0) return null;
  // Price of this asset drops by fraction d. Both its collateral value and its own debt shrink.
  // Solve: (W - a·d) / (D - b·d) = 1  →  d = (W - D) / (a - b)
  const a = pos.supplied * pos.priceUsd * pos.liquidationThreshold;
  const b = pos.borrowed * pos.priceUsd;
  if (a - b <= 0) return null;
  const d = (h.weightedCollateralUsd - h.debtUsd) / (a - b);
  return d >= 1 ? null : d; // null → even a 100% drop of this asset alone won't liquidate
}

export function round(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
