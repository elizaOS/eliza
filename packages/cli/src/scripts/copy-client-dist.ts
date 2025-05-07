import { copyClientDist } from '@/src/utils';

/**
 * Asynchronous function that runs the copy-client-dist script.
 * It first logs a message indicating that the script is running,
 * then awaits the completion of the copyClientDist function,
 * and finally logs a message indicating that the script has been completed.
 */
async function main() {
  await copyClientDist();
}

main().catch((error) => {
  console.error('Error running copy-client-dist script:', error);
  process.exit(1);
});
