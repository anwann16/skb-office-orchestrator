import { startLoop } from "./orchestrator/loop";

async function main(): Promise<void> {
  await startLoop();
}

main().catch((error) => {
  console.error("[Orchestrator] Fatal error:", error);

  process.exit(1);
});
