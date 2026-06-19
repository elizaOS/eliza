export default function throttle(func, wait = 0) {
  let timeout;
  let lastCall = 0;
  let lastArgs;
  let lastThis;
  let result;

  const invoke = () => {
    lastCall = Date.now();
    timeout = undefined;
    result = func.apply(lastThis, lastArgs);
    lastArgs = undefined;
    lastThis = undefined;
  };

  function throttled(...args) {
    lastArgs = args;
    lastThis = this;
    const remaining = wait - (Date.now() - lastCall);
    if (remaining <= 0 || remaining > wait) {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      invoke();
    } else if (timeout === undefined) {
      timeout = setTimeout(invoke, remaining);
    }
    return result;
  }

  throttled.cancel = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    lastArgs = undefined;
    lastThis = undefined;
  };

  throttled.flush = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      invoke();
    }
    return result;
  };

  return throttled;
}
