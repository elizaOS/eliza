import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";

const StyledBrand = styled.div`
  position: relative;
  display: inline-block;
  flex: 1;
  & h1 {
    font-weight: 700;
    font-size: 24px;
    & a {
      color: var(--font-color);
      padding: 0;
      display: inline;
    }
  }
  & span {
    color: var(--font-color);
    position: absolute;
    top: 5px;
    left: 175px;
    text-transform: uppercase;
    font-weight: 300;
    font-size: 1.5rem;
  }
  & .short {
    display: none;
  }
  @media screen and (max-width: 1024px) {
    & span {
      display: none;
    }
    & h1 {
      display: none;
    }
    & .short {
      display: block;
    }
  }
  @media screen and (max-width: 640px) {
  }
`;

const Brand = () => (
  <StyledBrand>
    <h1>
      <Link to="/">Air Board Game</Link>
    </h1>
    <h1 className="short">
      <Link to="/">ABG</Link>
    </h1>
  </StyledBrand>
);

export default Brand;
