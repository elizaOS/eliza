import React from "react";

import styled from "styled-components";

import Spinner from "./Spinner";

const Overlay = styled.div`
  position: fixed;
  width: 100vw;
  height: 100vh;
  top: 0;
  left: 0;
  background-color: var(--bg-color);
  opacity: 0.7;
  color: #606984;
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 295;
  font-size: 3em;
`;

const Waiter = ({ message }) => {
  return (
    <Overlay>
      {message && <div>{message}</div>}
      {!message && <Spinner />}
    </Overlay>
  );
};

export default Waiter;
