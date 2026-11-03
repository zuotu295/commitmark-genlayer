/* End-to-end on-chain loop against an already-deployed CommitMark contract.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... GENLAYER_PRIVATE_KEY=0x... node scripts/flow.mjs
 *   # or without a key: an ephemeral account is used (permissionless writes).
 *
 * Steps: claim a real contribution (torvalds / torvalds/linux) -> verify it
 * (validators fetch the GitHub commits API and must agree) -> read it back
 * as verified -> claim a non-contribution -> verify -> read it back as
 * refuted -> read both profiles back. Writes evidence.json (tx hashes,
 * final status, readbacks). No key is ever written to disk.
 * Reads retry briefly: a freshly FINALIZED contract can take a moment to
 * appear on the read path. Retries apply to reads only, never to writes.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

async function writeClaim(username, repo, note) {
  const tx = await client.writeContract({
    address,
    functionName: "claim_contribution",
    args: [username, repo, note],
    value: 0n,
    leaderOnly: false,
  });
  await waitFinal(tx, `claim ${username}/${repo}`);
  const countRaw = await readRetry(
    () => client.readContract({ address, functionName: "get_claim_count", args: [] }),
    "get_claim_count",
  );
  const id = Number(countRaw) - 1;
  return { tx, id };
}

async function verifyClaim(id) {
  const tx = await client.writeContract({
    address,
    functionName: "verify_contribution",
    args: [BigInt(id)],
    value: 0n,
    leaderOnly: false,
  });
  await waitFinal(tx, `verify claim ${id}`);
  return tx;
}

async function readClaim(id) {
  const raw = await readRetry(
    () => client.readContract({ address, functionName: "get_claim", args: [id] }),
    `get_claim ${id}`,
  );
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function readProfile(username) {
  const raw = await readRetry(
    () => client.readContract({ address, functionName: "get_profile", args: [username] }),
    `get_profile ${username}`,
  );
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// Claim 0: a real contribution. torvalds has authored commits in torvalds/linux.
const trueClaim = await writeClaim("torvalds", "torvalds/linux", "milestone demo verified");
const trueSettleTx = await verifyClaim(trueClaim.id);
const trueRecord = await readClaim(trueClaim.id);
console.log("True claim readback:", JSON.stringify(trueRecord));
if (trueRecord.status !== "verified") {
  throw new Error(`True claim did not verify (status: ${trueRecord.status}); refusing to write success evidence`);
}

// Claim 1: a non-contribution. This username has no commits in torvalds/linux.
const falseClaim = await writeClaim("definitely-not-a-contributor-xyz", "torvalds/linux", "milestone demo refuted");
const falseSettleTx = await verifyClaim(falseClaim.id);
const falseRecord = await readClaim(falseClaim.id);
console.log("False claim readback:", JSON.stringify(falseRecord));
if (falseRecord.status !== "refuted") {
  throw new Error(`False claim did not refute (status: ${falseRecord.status}); refusing to write success evidence`);
}

const torvaldsProfile = await readProfile("torvalds");
console.log("torvalds profile:", JSON.stringify(torvaldsProfile));
if (
  torvaldsProfile.count !== 1 ||
  torvaldsProfile.score !== 1 ||
  JSON.stringify(torvaldsProfile.badges) !== JSON.stringify(["Contributor"]) ||
  JSON.stringify(torvaldsProfile.repos) !== JSON.stringify(["torvalds/linux"])
) {
  throw new Error("torvalds profile does not match the expected verified profile");
}

const xyzProfile = await readProfile("definitely-not-a-contributor-xyz");
console.log("xyz profile:", JSON.stringify(xyzProfile));
if (xyzProfile.count !== 0) {
  throw new Error("xyz profile should have count 0");
}

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  contractFile: "contracts/commitmark.py",
  contractSha256: deployment.contractSha256,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  deployTxHash: deployment.deployTxHash,
  flowAccount: account.address,
  claims: {
    trueClaim: {
      id: trueClaim.id,
      createTxHash: trueClaim.tx,
      settleTxHash: trueSettleTx,
      claim: trueRecord,
    },
    falseClaim: {
      id: falseClaim.id,
      createTxHash: falseClaim.tx,
      settleTxHash: falseSettleTx,
      claim: falseRecord,
    },
  },
  profiles: {
    torvalds: torvaldsProfile,
    "definitely-not-a-contributor-xyz": xyzProfile,
  },
  scope:
    "Demo loop only. All writes used an ephemeral in-memory script account on gasless Studionet; no adoption claim is made and no real user data is involved. Claims attest public contribution facts only and do not prove account ownership.",
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
