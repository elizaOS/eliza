import React from "react";
import styled from "styled-components";
import { useNavigate } from "react-router-dom";
import FixedButton from "./FixedButton";

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  line-height: 38px;

  @media screen and (max-width: 640px) {
    & > span {
      font-size: 0.8em;
    }
  }
`;

const StyledButton = styled(FixedButton).attrs(({ active }) => ({
  className: active ? "active" : "",
}))`
  border-radius: 100%;
  line-height: 1;
  text-decoration: none;
  display: inline-block;
  cursor: pointer;
  border-color: transparent;
  color: var(--font-color);
  background-color: var(--color-midGrey);
  padding: 0.5rem;
  width: 38px;
  height: 38px;
  display: flex;
  justify-content: center;
  align-items: center;
  &:hover,
  &.active {
    background-color: var(--color-primary);
  }
  box-shadow: 3px 3px 6px #00000050;
`;

const Touch = ({ onClick, to, icon, title, alt, active, label, ...rest }) => {
  // Touch icon
  const navigate = useNavigate();
  const handleClick = React.useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (onClick) {
        onClick(e);
      }
      if (to) {
        navigate(to);
      }
    },
    [onClick, to, navigate]
  );

  const iconSrc =
    icon.startsWith("http") || icon.startsWith("/")
      ? icon
      : `https://icongr.am/entypo/${icon}.svg?size=24&color=f9fbfa`;

  return (
    <StyledWrapper {...rest}>
      <StyledButton onClick={handleClick} active={active}>
        <img src={iconSrc} alt={alt} title={title} />
      </StyledButton>
      {label && <span>{label}</span>}
    </StyledWrapper>
  );
};

export default Touch;
