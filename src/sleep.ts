/**
 * Creates a promise to block the process for the provided time.
 *
 * @param ms Number of milliseconds to sleep for.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
