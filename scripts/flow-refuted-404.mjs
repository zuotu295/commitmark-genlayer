/* Complete the refuted half of the demo loop via the 404 path.
 *
 * Background: GitHub's commits API returns HTTP 500 (not HTTP 200 with an
 * empty array) for author queries with no matching commits, so the
 * author-filter refuted case correctly fail-closes by design and its claim
 * stays pending. A nonexistent repo returns HTTP 404, which the contract
 * maps to refuted. This script settles a refuted claim through that path.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... GENLAYER_PRIVATE_KEY=0x... node scripts/flow-refuted-404.mjs
 *   # or without a key: an ephemeral account is used (permissionless writes).
 * No key is ever written to disk. Reads retry briefly; retries apply to
 * reads only, never to writes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const account = createAccount(process.env.GENLAYER_PRIVATE_KEY || generatePrivateKey());
console.log("Flow account:", account.address);
console.log("Contract:", address);
const client = createClient({ chain: studionet, account });

async function waitFinal(hash, label) {
  console.log(`${label} tx:`, hash);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    retries: 180,
    interval: 5000,
  });
  console.log(`${label} final:`, receipt.statusName ?? receipt.status);
  return receipt;
}

async function readRetry(fn, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      console.log(`${label} read attempt ${attempt} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  throw lastError;
}

const createTx = await client.writeContract({
  address,
  functionName: "claim_contribution",
  args: ["torvalds", "torvalds/this-repo-does-not-exist-xyz", "demo refuted via 404"],
  value: 0n,
  leaderOnly: false,
});
const createReceipt = await waitFinal(createTx, "create-refuted-404");
console.log("create receipt:", createReceipt.statusName ?? createReceipt.status);

const countRaw = await readRetry(
  () => client.readContract({ address, functionName: "get_claim_count", args: [] }),
  "get_claim_count",
);
const id = BigInt(Number(countRaw) - 1);
console.log("New claim id:", id.toString());

const verifyTx = await client.writeContract({
  address,
  functionName: "verify_contribution",
  args: [id],
  value: 0n,
  leaderOnly: false,
});
const verifyReceipt = await waitFinal(verifyTx, "verify-refuted-404");
console.log("verify receipt:", verifyReceipt.statusName ?? verifyReceipt.status);

const claimRaw = await readRetry(
  () => client.readContract({ address, functionName: "get_claim", args: [id] }),
  "get_claim",
);
const claim = typeof claimRaw === "string" ? JSON.parse(claimRaw) : claimRaw;
console.log("Claim readback:", JSON.stringify(claim));
if (claim.status !== "refuted") {
  throw new Error(`Expected refuted claim, got ${claim.status}`);
}

const profileRaw = await readRetry(
  () => client.readContract({ address, functionName: "get_profile", args: ["torvalds"] }),
  "get_profile",
);
const profile = typeof profileRaw === "string" ? JSON.parse(profileRaw) : profileRaw;
console.log("Torvalds profile readback:", JSON.stringify(profile));
if (profile.count !== 1) {
  throw new Error(`Expected torvalds count to stay 1 after a refuted claim, got ${profile.count}`);
}

console.log(JSON.stringify({
  createTxHash: createTx,
  createReceipt: createReceipt.statusName ?? String(createReceipt.status),
  verifyTxHash: verifyTx,
  verifyReceipt: verifyReceipt.statusName ?? String(verifyReceipt.status),
  claim,
  profile,
  flowAccount: account.address,
}, null, 2));
