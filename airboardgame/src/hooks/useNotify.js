import React from "react";

const useNotify = () => {
  const [count, setCount] = React.useState(0);

  const add = React.useCallback(() => {
    setCount((prev) => prev + 1);
  }, []);

  const reset = React.useCallback(() => {
    setCount(0);
  }, []);

  return { count, add, reset };
};

export default useNotify;
