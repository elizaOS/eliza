import React from "react";
import { useQuery } from "react-query";
import {
  login as loginAPI,
  logout as logoutAPI,
  checkAuthentication,
  getAccount,
} from "../utils/api";
import useLocalStorage from "../hooks/useLocalStorage";

const useAuth = () => {
  const [isAuthenticated, setIsAuthenticated] = useLocalStorage(
    "isAuthenticated",
    false
  );
  const [userId, setUserId] = useLocalStorage("userId", null);

  const { data: userAccount } = useQuery("account", async () =>
    isAuthenticated ? await getAccount(userId) : null
  );

  const login = React.useCallback(
    async (userHash, token) => {
      await loginAPI(userHash, token);
      setIsAuthenticated(true);
      setUserId(userHash);
    },
    [setIsAuthenticated, setUserId]
  );

  const logout = React.useCallback(async () => {
    await logoutAPI();
    setIsAuthenticated(false);
    setUserId(null);
  }, [setIsAuthenticated, setUserId]);

  React.useEffect(() => {
    const checkAuth = async () => {
      const authResult = await checkAuthentication();
      if (!authResult) {
        setIsAuthenticated(false);
      }
    };

    if (isAuthenticated) {
      checkAuth();
    }
  }, [isAuthenticated, setIsAuthenticated]);

  return {
    isAuthenticated,
    userId,
    login,
    logout,
    userAccount,
  };
};

export default useAuth;
