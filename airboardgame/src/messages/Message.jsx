import React from "react";
import styled from "styled-components";

const StyledMessage = styled.div`
  font-size: 1.2em;
  & .line {
    display: flex;
    flex-direction: row;
    padding: 0rem 0.2rem;
    padding: 0.5rem 0;
    & p {
      margin: 0;
    }
  }
  & .name {
    padding-left: 0.5em;
    font-size: 1.3em;
    ${({ color }) => `color: ${color};`}
    text-shadow: 0px 0px 1px var(--color-grey);
  }
  & .left-block {
    padding: 0 1rem;
    opacity: 0.05;
  }
  &:hover {
    & .line {
      background-color: var(--color-midGrey);
    }
    & .left-block {
      opacity: 0.8;
    }
  }
`;

const Message = ({
  first,
  user: { name, color = "#dddddd" },
  timestamp,
  content,
}) => (
  <StyledMessage color={color}>
    {first && <div className="name">{name}</div>}
    <div className="line">
      <div className="left-block">
        <span>{timestamp.format("HH:mm")}</span>
      </div>
      <p>{content}</p>
    </div>
  </StyledMessage>
);

export default Message;
