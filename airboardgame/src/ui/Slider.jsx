import React from "react";
import RCSlider from "rc-slider";
import styled from "styled-components";

import "rc-slider/assets/index.css";

const StyledSlider = styled.div`
  margin: 0 0.5em;

  .rc-slider-mark-text {
    font-size: 1rem;
  }

  .rc-slider-mark-text-active {
    color: white;
    font-weight: bold;
    font-size: 1.2rem;
    border-radius: 1rem;
    padding: 2px 7px 0px 7px;
    background-color: var(--color-primary);
  }
`;

export const sliderStyling = {
  handleStyle: [
    {
      backgroundColor: "white",
      borderColor: "white",
    },
  ],
  railStyle: {
    backgroundColor: "var(--color-primary)",
  },
  dotStyle: {
    backgroundColor: "var(--font-color2)",
    border: "var(--font-color2)",
    width: "6px",
    height: "6px",
    bottom: "-1px",
  },
};

// Please check https://github.com/react-component/slider#user-content-common-api
// for all available props.
// RCSlider refers to the Slider component of the rc-react library.
const Slider = (props) => {
  return (
    <StyledSlider className={props.className}>
      <RCSlider {...props} {...sliderStyling} />
    </StyledSlider>
  );
};

export default Slider;
