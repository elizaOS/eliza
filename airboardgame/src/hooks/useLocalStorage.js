import React from "react";
import { atomFamily, useRecoilState } from "recoil";

const getFromLocalStorage = (key) => {
  const item = window.localStorage.getItem(key);
  if (item === null) {
    return null;
  }
  return JSON.parse(item);
};

const localStorageFamily = atomFamily({
  key: "localstorage",
  default: (key) => [false, getFromLocalStorage(key)],
});

const useLocalStorage = (key, initialValue) => {
  const [[loaded, storedValue], setStoredValue] = useRecoilState(
    localStorageFamily(key)
  );

  React.useEffect(() => {
    if (!loaded) {
      try {
        // Get from local storage by key
        const item = window.localStorage.getItem(key);

        if (item === null) {
          // If missing we add it
          window.localStorage.setItem(key, JSON.stringify(initialValue));
          setStoredValue([true, initialValue]);
        }
        setStoredValue([true, JSON.parse(item)]);
      } catch (error) {
        // If error also return initialValue
        console.log(error);
        setStoredValue([true, initialValue]);
      }
    }
  }, [initialValue, key, loaded, setStoredValue]);

  // Return a wrapped version of useState's setter function that ...
  // ... persists the new value to localStorage.
  const setValue = React.useCallback(
    (value) => {
      try {
        // Save state
        setStoredValue(([, prev]) => {
          // Allow value to be a function so we have same API as useState
          const valueToStore = value instanceof Function ? value(prev) : value;

          // Save to local storage
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
          return [true, valueToStore];
        });
      } catch (error) {
        // A more advanced implementation would handle the error case
        console.log(error);
      }
    },
    [key, setStoredValue]
  );

  // React on other tab modifications
  React.useEffect(() => {
    const localStorageChanged = (e) => {
      if (e.key === key) {
        setStoredValue([true, JSON.parse(e.newValue)]);
      }
    };
    window.addEventListener("storage", localStorageChanged);
    return () => {
      window.removeEventListener("storage", localStorageChanged);
    };
  }, [key, setStoredValue]);

  return [storedValue === null ? initialValue : storedValue, setValue];
};

export default useLocalStorage;
