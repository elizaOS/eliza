import React from "react";
import styled from "styled-components";
import useLocalStorage from "../hooks/useLocalStorage";
import { useTranslation } from "react-i18next";

const StyledNotice = styled.div`
  position: fixed;
  bottom: 1em;
  background-color: var(--color-blueGrey);
  z-index: 210;
  right: 1em;
  display: flex;
  flex-direction: column;
  padding: 1em;
  box-shadow: 0px 3px 6px hsla(0, 80%, 0%, 0.7);
  align-items: end;
  border-radius: 5px;
  width: 320px;
  & p {
    flex: 1;
    text-align: left;
  }
`;

const CookieNotice = () => {
  const { t } = useTranslation();

  const [showNotice, setShowNotice] = React.useState(true);

  const [cookieConsent, setCookieConsent] = useLocalStorage(
    "cookieConsent",
    false
  );

  const onAccept = React.useCallback(() => {
    setCookieConsent(true);
  }, [setCookieConsent]);

  const onRefuse = React.useCallback(() => {
    setCookieConsent(false);
    setShowNotice(false);
  }, [setCookieConsent]);

  if (!showNotice || cookieConsent === true) {
    return null;
  }

  return (
    <StyledNotice>
      <p>{t("Cookie consent message")}</p>
      <div>
        <button onClick={onRefuse} className="button refuse">
          {t("Refuse")}
        </button>
        <button onClick={onAccept} className="button accept success">
          {t("Got it!")}
        </button>
      </div>
    </StyledNotice>
  );
};

export const useCookieConsent = () => {
  const [cookieConsent] = useLocalStorage("cookieConsent", false);
  return cookieConsent;
};

export default CookieNotice;
