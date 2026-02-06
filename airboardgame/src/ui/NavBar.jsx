import React from "react";
import styled from "styled-components";
import { useMediaQuery } from "@react-hookz/web/esm/useMediaQuery";

import { FiChevronsDown, FiChevronsUp } from "react-icons/fi";
import { useTranslation } from "react-i18next";

import NavButton from "./NavButton";

const StyledNavBar = styled.div`
  position: fixed;
  top: 0;
  z-index: 205;
  display: flex;
  flex-direction: column;
  justify-content: start;
  align-items: center;
  padding: 5px 0;
  width: 40px;
  z-index: 215;
  line-height: normal;

  background-color: #19202cf5;

  &.nav-bar--full-height {
    height: 100%;
  }

  &.nav-bar--folded {
    height: auto;

    & .spacer {
      display: none;
    }

    & .sep {
      display: none;
    }

    & > :not(.keep-folded) {
      display: none;
    }
  }

  &.nav-bar--left {
    left: 0;
    border-right: 1px solid #3c3c42f5;
  }

  &.nav-bar--right {
    right: 0;
    border-left: 1px solid #3c3c42f5;
  }

  .blurry & {
    filter: blur(2px) grayscale(50%);
  }

  color: var(--font-color);

  & .spacer {
    flex: 1;
  }

  & .sep {
    height: 1.5em;
    width: 80%;
  }

  & .nav-bar__toggle-button {
    margin-top: 10px;
    border-top: 1px solid var(--color-grey);
  }

  @media screen and (max-width: 640px) {
  }
`;

const NavBar = ({ fullHeight = true, position = "left", children }) => {
  const { t } = useTranslation();
  const isSmallDevice = useMediaQuery("only screen and (max-width : 640px)");

  const [folded, setFolded] = React.useState(isSmallDevice);
  const classes = ["nav-bar"];
  if (fullHeight) {
    classes.push("nav-bar--full-height");
  }
  if (folded) {
    classes.push("nav-bar--folded");
  }
  if (position === "right") {
    classes.push("nav-bar--right");
  } else {
    classes.push("nav-bar--left");
  }
  return (
    <StyledNavBar className={classes.join(" ")}>
      {children}
      <div className="keep-folded nav-bar__toggle-button">
        <NavButton
          onClick={() => {
            setFolded((prev) => !prev);
          }}
          alt={t("Fold/Unfold")}
          Icon={folded ? FiChevronsDown : FiChevronsUp}
        />
      </div>
    </StyledNavBar>
  );
};

export default NavBar;
