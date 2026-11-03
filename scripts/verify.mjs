/* Independently re-check evidence.json against Stable Studionet.
 *
 * Usage: node scripts/verify.mjs
 *
 * Read-only: re-reads every transaction in evidence.json (deploy + loop),
 * requires FINALIZED + SUCCESS, then re-reads the claims and profiles and
 * compares them to the recorded readbacks. Prints PASS/FAIL per check and
 * exits non-zero on any mismatch. Retries reads briefly; retries apply to
 * reads only, never to writes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const evidence = JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf-8"));
const address = deployment.contractAddress;
const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api" });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function readRetry(fn, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  throw lastError;
}

async function checkTx(label, hash) {
  try {
    const tx = await client.getTransaction({ hash });
    const receipts = tx.consensus_data?.leader_receipt;
    const list = Array.isArray(receipts) ? receipts : receipts ? [receipts] : [];
    const leader = list.find((r) => r.mode === "leader") ?? list[0];
    const result = leader?.execution_result;
    const votes = Object.values(tx.consensus_data?.votes ?? {}).map((v) => String(v).toLowerCase());
    const agree = votes.filter((v) => v === "agree").length;
    const ok =
      tx.statusName === "FINALIZED" && (result === "SUCCESS" || result === "success");
    check(label, ok, `${tx.statusName}/${result} agree ${agree}/${votes.length}`);
  } catch (e) {
    check(label, false, `error: ${String(e).slice(0, 120)}`);
  }
}

await checkTx("deploy", evidence.deployTxHash);
await checkTx("create true claim", evidence.claims.trueClaim.createTxHash);
await checkTx("settle true claim", evidence.claims.trueClaim.settleTxHash);
await checkTx("create false claim", evidence.claims.falseClaim.createTxHash);
await checkTx("settle false claim", evidence.claims.falseClaim.settleTxHash);

async function readJson(fnName, args) {
  const raw = await readRetry(
    () => client.readContract({ address, functionName: fnName, args }),
    `${fnName}`,
  );
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

const trueRecord = await readJson("get_claim", [evidence.claims.trueClaim.id]);
check(
  "true claim readback",
  trueRecord.status === "verified" &&
    JSON.stringify(trueRecord) === JSON.stringify(evidence.claims.trueClaim.claim),
  trueRecord.status,
);
const falseRecord = await readJson("get_claim", [evidence.claims.falseClaim.id]);
check(
  "false claim readback",
  falseRecord.status === "refuted" &&
    JSON.stringify(falseRecord) === JSON.stringify(evidence.claims.falseClaim.claim),
  falseRecord.status,
);
const torvalds = await readJson("get_profile", ["torvalds"]);
check(
  "torvalds profile",
  torvalds.count === 1 &&
    torvalds.score === 1 &&
    JSON.stringify(torvalds.badges) === JSON.stringify(["Contributor"]) &&
    JSON.stringify(torvalds.repos) === JSON.stringify(["torvalds/linux"]),
  JSON.stringify(torvalds),
);
const xyz = await readJson("get_profile", ["definitely-not-a-contributor-xyz"]);
check("xyz profile count 0", xyz.count === 0, JSON.stringify(xyz));
const count = await readJson("get_claim_count", []);
check("claim count 2", Number(count) === 2, String(count));

if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All evidence checks passed");
