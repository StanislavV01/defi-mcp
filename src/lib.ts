/**
 * Library entry: use defi-mcp's Aave reads and risk math directly from
 * TypeScript (e.g. inside an AI SDK agent) without running the MCP server.
 */
export { CHAIN_NAMES, SUPPORTED_CHAINS, getClient, type ChainName } from "./chains.js";
export {
  getAccount,
  getContracts,
  getMarkets,
  getWalletBalances,
  toSimPositions,
  type AccountSummary,
  type Market,
  type UserReserve,
} from "./aave/client.js";
export * from "./math.js";
