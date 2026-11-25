import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";

/**
 * Aave V3 PoolAddressesProvider per chain. Everything else (Pool, Oracle,
 * ProtocolDataProvider) is resolved from it at runtime, so upgrades on Aave's
 * side don't break us. Source: https://github.com/bgd-labs/aave-address-book
 */
export const SUPPORTED_CHAINS = {
  ethereum: {
    chain: mainnet,
    addressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    rpcEnv: "RPC_URL_ETHEREUM",
  },
  base: {
    chain: base,
    addressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    rpcEnv: "RPC_URL_BASE",
  },
  arbitrum: {
    chain: arbitrum,
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    rpcEnv: "RPC_URL_ARBITRUM",
  },
  optimism: {
    chain: optimism,
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    rpcEnv: "RPC_URL_OPTIMISM",
  },
  polygon: {
    chain: polygon,
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    rpcEnv: "RPC_URL_POLYGON",
  },
} as const satisfies Record<string, { chain: Chain; addressesProvider: Address; rpcEnv: string }>;

export type ChainName = keyof typeof SUPPORTED_CHAINS;
export const CHAIN_NAMES = Object.keys(SUPPORTED_CHAINS) as [ChainName, ...ChainName[]];

const clients = new Map<ChainName, PublicClient>();

/** Cached viem client. Uses RPC_URL_<CHAIN> if set, otherwise the chain's public RPC. */
export function getClient(name: ChainName): PublicClient {
  let client = clients.get(name);
  if (!client) {
    const cfg = SUPPORTED_CHAINS[name];
    const url = process.env[cfg.rpcEnv];
    client = createPublicClient({
      chain: cfg.chain,
      transport: http(url, { batch: true, retryCount: 2, timeout: 20_000 }),
    }) as unknown as PublicClient;
    clients.set(name, client);
  }
  return client;
}
