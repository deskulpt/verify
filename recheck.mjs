// Re-verify every company saved through POST /v1/verify (with a ref) and report status changes.
// Cron, e.g. daily at 03:00:  0 3 * * *  cd /path/to/biz-verify && node recheck.mjs >> data/recheck.log
// Exit code 2 when any company changed status, so a scheduler can alert on it.
import { saveCheck, store, verify } from "./server.mjs";

const latest = store()
  .prepare("SELECT ref, form, status FROM checks WHERE id IN (SELECT MAX(id) FROM checks GROUP BY ref)")
  .all();

let changed = 0;
for (const row of latest) {
  const form = JSON.parse(row.form);
  try {
    const result = await verify(form);
    saveCheck(row.ref, form, result);
    const now = result.summary.status;
    if (now !== row.status) changed++;
    console.log(`${new Date().toISOString()} ${row.ref} ${form.country} "${form.name}": ${row.status} -> ${now}${now !== row.status ? "  CHANGED" : ""}`);
  } catch (e) {
    console.error(`${row.ref}: ${e.message}`);
  }
  // ponytail: fixed 1s gap keeps every registry well under its rate limit; per-source limits if the list grows large
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`rechecked ${latest.length}, changed ${changed}`);
process.exitCode = changed ? 2 : 0;
