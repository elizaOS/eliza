import React from "react";
import styled from "styled-components";
import { useNavigate } from "react-router-dom";

import FixedButton from "./FixedButton";

const StyledNavButton = styled(FixedButton)`
  display: block;
  background-color: transparent;
  padding: 4px;
  margin: 0;
  border: none;
  line-height: 0;
  color: ${({ active }) => (active ? "var(--color-primary)" : "white")};
  cursor: ${({ disabled }) => (disabled ? "not-allowed" : "pointer")};
`;

const NavButton = ({
  Icon,
  icon,
  onClick,
  to,
  alt,
  title,
  active,
  disabled,
  size = 28,
}) => {
  const navigate = useNavigate();

  const handleClick = React.useCallback(
    (e) => {
      e.preventDefault();
      if (disabled) {
        return;
      }
      e.stopPropagation();
      if (onClick) {
        onClick(e);
      }
      if (to) {
        navigate(to);
      }
    },
    [disabled, onClick, to, navigate]
  );

  let component;
  if (Icon) {
    component = <Icon size={size} alt={alt} />;
  } else {
    const iconSrc =
      icon.startsWith("http") || icon.startsWith("/")
        ? icon
        : `https://icongr.am/entypo/${icon}.svg?size=${size}&color=f9fbfa`;

    component = <img src={iconSrc} alt={alt} width={size} />;
  }

  return (
    <StyledNavButton
      active={active}
      disabled={disabled}
      onClick={handleClick}
      title={title}
    >
      {component}
    </StyledNavButton>
  );
};

export default NavButton;
