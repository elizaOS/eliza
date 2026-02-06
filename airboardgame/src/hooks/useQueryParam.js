import { useLocation } from "react-router-dom";

const useQueryParam = () => {
  return new URLSearchParams(useLocation().search);
};

export default useQueryParam;
