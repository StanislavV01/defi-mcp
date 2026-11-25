import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAction,
  computeHealth,
  fromUnits,
  liquidationPriceDrop,
  rayRateToApy,
  type SimPosition,
} from "../src/math.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const weth = { symbol: "WETH", priceUsd: 3000, liquidationThreshold: 0.83 };
const usdc = { symbol: "USDC", priceUsd: 1, liquidationThreshold: 0.78 };

const base: SimPosition[] = [
  { ...weth, supplied: 1, borrowed: 0, usedAsCollateral: true },
  { ...usdc, supplied: 0, borrowed: 1000, usedAsCollateral: true },
];

test("fromUnits", () => {
  assert.equal(fromUnits(1_500_000n, 6), 1.5);
  assert.equal(fromUnits(0n, 18), 0);
  close(fromUnits(123456789000000000000n, 18), 123.456789);
});

test("rayRateToApy: 5% APR compounds to ~5.127% APY", () => {
  close(rayRateToApy(5n * 10n ** 25n), 0.05127, 1e-4);
  assert.equal(rayRateToApy(0n), 0);
});

test("health factor = Σ collateral·LT / debt", () => {
  const h = computeHealth(base);
  close(h.healthFactor, (3000 * 0.83) / 1000);
  assert.equal(computeHealth([{ ...weth, supplied: 1, borrowed: 0, usedAsCollateral: true }]).healthFactor, Infinity);
});

test("collateral disabled → not counted", () => {
  const h = computeHealth([{ ...base[0]!, usedAsCollateral: false }, base[1]!]);
  assert.equal(h.healthFactor, 0);
});

test("applyAction borrow lowers HF, repay raises it, original untouched", () => {
  const more = applyAction(base, "borrow", "USDC", 500);
  close(computeHealth(more).healthFactor, 2490 / 1500);
  const less = applyAction(base, "repay", "usdc", 500);
  close(computeHealth(less).healthFactor, 2490 / 500);
  assert.equal(base[1]!.borrowed, 1000);
});

test("applyAction adds a new asset from market data", () => {
  const next = applyAction(base, "supply", "WBTC", 0.1, { symbol: "WBTC", priceUsd: 60000, liquidationThreshold: 0.78 });
  close(computeHealth(next).healthFactor, (2490 + 6000 * 0.78) / 1000);
});

test("applyAction rejects impossible actions", () => {
  assert.throws(() => applyAction(base, "withdraw", "WETH", 2));
  assert.throws(() => applyAction(base, "repay", "USDC", 2000));
  assert.throws(() => applyAction(base, "borrow", "USDC", 0));
  assert.throws(() => applyAction(base, "supply", "NOPE", 1));
});

test("liquidationPriceDrop: HF hits exactly 1 after the drop", () => {
  const d = liquidationPriceDrop(base, "WETH")!;
  close(d, 1 - 1000 / 2490);
  const dropped = base.map((p) => (p.symbol === "WETH" ? { ...p, priceUsd: p.priceUsd * (1 - d) } : p));
  close(computeHealth(dropped).healthFactor, 1);
});

test("liquidationPriceDrop: null without debt", () => {
  assert.equal(liquidationPriceDrop([base[0]!], "WETH"), null);
});
