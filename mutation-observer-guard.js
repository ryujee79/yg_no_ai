(() => {
  const NativeMutationObserver = window.MutationObserver;
  if (!NativeMutationObserver || window.__ygMutationObserverGuardInstalled) return;
  window.__ygMutationObserverGuardInstalled = true;

  class GuardedMutationObserver {
    constructor(callback) {
      this._callback = callback;
      this._target = null;
      this._options = null;
      this._running = false;
      this._native = new NativeMutationObserver((records) => {
        if (this._running) return;
        this._running = true;
        const target = this._target;
        const options = this._options;
        this._native.disconnect();
        try {
          this._callback(records, this);
        } finally {
          this._running = false;
          if (target && options) this._native.observe(target, options);
        }
      });
    }

    observe(target, options) {
      this._target = target;
      this._options = options;
      this._native.observe(target, options);
    }

    disconnect() {
      this._target = null;
      this._options = null;
      this._native.disconnect();
    }

    takeRecords() {
      return this._native.takeRecords();
    }
  }

  window.MutationObserver = GuardedMutationObserver;
})();
