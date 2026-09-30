import { POLL_INTERVAL_MS } from "../config";

import { dispatchQA, dispatchWorkers } from "./dispatcher";

let ticking = false;

export async function tick(): Promise<void> {
  /*
   * Mencegah tick berikutnya masuk sebelum
   * tick sebelumnya selesai.
   */
  if (ticking) {
    return;
  }

  ticking = true;

  try {
    await dispatchWorkers();

    await dispatchQA();
  } catch (error) {
    console.error("[Orchestrator] Tick error:", error);
  } finally {
    ticking = false;
  }
}

export async function startLoop(): Promise<void> {
  console.log("[Orchestrator] AI Office Orchestrator started");

  console.log(`[Orchestrator] Poll interval: ${POLL_INTERVAL_MS}ms`);

  await tick();

  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
