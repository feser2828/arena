import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { config } from "./config.js";

export const pub = createPublicClient({ chain: avalanche, transport: http(config.rpc) });

export function makeWallet(label: string, key: Hex) {
  const account = privateKeyToAccount(key);
    const base = createWalletClient({ account, chain: avalanche, transport: http(config.rpc) });
  // Dry-run every contract write first. If it would revert, nothing is broadcast and no gas is spent.
  const client = {
    ...base,
    writeContract: async (args: any) => {
      await pub.simulateContract({ ...args, account });
      return base.writeContract(args);
    },
  };
  return { label, account, client };
}
export type Wallet = ReturnType<typeof makeWallet>;