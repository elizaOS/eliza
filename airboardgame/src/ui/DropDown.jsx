import React from "react";
import styled from "styled-components";

const StyledMenu = styled.div`
  position: absolute;
  right: -1em;
  width: max-content;

  & .content {
    margin-top: 20px;
    background-color: var(--color-midGrey);
    box-shadow: rgba(0, 0, 0, 0.24) 0px 3px 8px;
    border-radius: 5px;
    max-height: 25em;
    overflow-y: scroll;
  }

  &:after {
    content: "";
    position: absolute;
    top: 5px;
    right: 1.2em;
    border-width: 0 15px 15px;
    border-style: solid;
    border-color: var(--color-midGrey) transparent;
  }
`;

const DropDown = ({ open, children }) => {
  if (!open) {
    return null;
  }

  return (
    <StyledMenu>
      <div className="content">{children}</div>
    </StyledMenu>
  );
};

export default DropDown;
