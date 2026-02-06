import React from "react";

import styled from "styled-components";
import FixedButton from "../ui/FixedButton";

const StyledUserCircle = styled(FixedButton)`
  margin: 0px;
  padding: 0px;
  background-color: ${({ color }) => color};
  width: 30px;
  min-width: 30px;
  height: 30px;
  margin: 2px;
  border-radius: 100%;
  text-align: center;
  line-height: 30px;
  text-transform: capitalize;
  ${({ isSelf }) => (isSelf ? "text-decoration: underline;" : "")};
  cursor: ${({ isSelf }) => (isSelf ? "pointer" : "default")};

  &:hover {
    ${({ isSelf }) => (isSelf ? "filter: brightness(125%);" : "")}
  }
`;

const UserCircle = ({ name, ...rest }) => {
  let pre = name.slice(0, 2).toLowerCase();
  return <StyledUserCircle {...rest}>{pre}</StyledUserCircle>;
};

export default UserCircle;
