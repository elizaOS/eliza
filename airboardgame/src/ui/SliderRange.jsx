import React from "react";
import { Range } from "rc-slider";
import styled from "styled-components";

import "rc-slider/assets/index.css";

const StyledSliderRange = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;

  > span {
    margin: 1em;
    color: var(--font-color2);
  }
`;

const sliderRangeStyling = {
  trackStyle: [
    {
      backgroundColor: "var(--color-primary)",
      height: "5px",
    },
  ],
  railStyle: {
    backgroundColor: "var(--font-color2)",
  },
  handleStyle: [
    {
      backgroundColor: "white",
      borderColor: "white",
    },
    {
      backgroundColor: "white",
      borderColor: "white",
    },
  ],
};

// Please check https://github.com/react-component/slider#user-content-common-api
// for all available props.
const SliderRange = ({
  defaultValue: [defaultMin, defaultMax],
  plusSignMode = true,
  ...props
}) => {
  const [minMaxValues, setMinMaxValues] = React.useState([
    props.value.length ? props.value[0] : defaultMin,
    props.value.length ? props.value[1] : defaultMax,
  ]);

  const onChangeCustom = function (values) {
    setMinMaxValues(values);
    props.onChange(values);
  };

  return (
    <StyledSliderRange className={props.className}>
      <span>{`${minMaxValues[0]}`}</span>
      <Range
        {...props}
        {...sliderRangeStyling}
        value={props.value.length ? props.value : [defaultMin, defaultMax]}
        onChange={onChangeCustom}
      />
      <span>{`${minMaxValues[1]}${
        plusSignMode && minMaxValues[1] == props.max ? "+" : ""
      }`}</span>
    </StyledSliderRange>
  );
};

export default SliderRange;
