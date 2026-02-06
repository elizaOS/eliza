import React from "react";
import { FullScreen, useFullScreenHandle } from "react-full-screen";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

export const FullScreenContext = React.createContext({});

export const FullScreenProvider = ({ children }) => {
  const { t } = useTranslation();
  const handle = useFullScreenHandle();

  const toggleFullScreen = React.useCallback(() => {
    try {
      handle.active ? handle.exit() : handle.enter();
    } catch (e) {
      toast.info(t("You don't have the permissions to go fullscreen"), {
        autoClose: 1000,
      });
    }
  }, [handle, t]);

  return (
    <FullScreen handle={handle}>
      <FullScreenContext.Provider
        value={{ toggleFullScreen, active: handle.active }}
      >
        {children}
      </FullScreenContext.Provider>
    </FullScreen>
  );
};

const useFullScreen = () => {
  return React.useContext(FullScreenContext);
};

export default useFullScreen;
