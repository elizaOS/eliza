import React from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import styled from "styled-components";

import Account from "./Account";
import useAuth from "../hooks/useAuth";

import Brand from "./Brand";
import { FiGithub } from "react-icons/fi";

const Nav = styled.nav`
  background-color: var(--bg-color);
  position: relative;
  padding: 0 5%;
  display: flex;
  align-items: center;

  & button,
  & .button {
    background: none;
    text-transform: uppercase;
    font-weight: 300;
    font-size: 1.3em;
    border-radius: 0;
    color: var(--font-color2);
    margin: 0 0.5em;
    letter-spacing: -1px;
    padding: 0;
  }

  & button:hover,
  & .button:hover,
  & .button.active {
    color: var(--font-color);
    border-bottom: 1px solid var(--color-primary);
  }

  @media screen and (max-width: 640px) {
    & .button,
    & button {
      display: none;
    }
  }
`;

const HomeNav = () => {
  const { t } = useTranslation();

  const cookieConsent = true;

  const { isAuthenticated } = useAuth();

  return (
    <>
      <Nav>
        <Brand />
        {isAuthenticated && (
          <>
            <NavLink to={"/games/"} className="button">
              {t("All games")}
            </NavLink>
            <NavLink to={"/studio/"} className="button">
              {t("Game studio")}
            </NavLink>
          </>
        )}
        <Account className="login" disabled={!cookieConsent} />
        <a
          className="icon button"
          href="https://github.com/jrmi/airboardgame"
          target="_blank"
          rel="noreferrer"
        >
          <FiGithub
            alt={t("Github")}
            title={t("Github")}
            color="#CCCCCC"
            size="16"
          />
        </a>
      </Nav>
    </>
  );
};

export default HomeNav;
