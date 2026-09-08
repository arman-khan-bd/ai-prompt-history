/**
 * Async Mutex / Lock implementation to safely serialize concurrent file operations
 */
export class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Run an asynchronous task exclusively. Ensures no other task runs concurrently on this lock.
   */
  public async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const currentQueue = this.queue;
    this.queue = this.queue.then(() => nextPromise);

    try {
      await currentQueue;
      return await callback();
    } finally {
      release!();
    }
  }
}
