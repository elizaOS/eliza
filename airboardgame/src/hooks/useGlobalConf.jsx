import React, { useContext } from "react";

export const GlobalConfContext = React.createContext({});

export const GlobalConfProvider = ({ children, ...rest }) => {
  const [editItem, setEditItem] = React.useState(false);
  const [other] = React.useState(rest);

  return (
    <GlobalConfContext.Provider value={{ editItem, setEditItem, ...other }}>
      {children}
    </GlobalConfContext.Provider>
  );
};

export const useGlobalConf = () => {
  return useContext(GlobalConfContext);
};

export default useGlobalConf;
