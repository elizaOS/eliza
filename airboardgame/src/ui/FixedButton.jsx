import React from "react";

import { useEventListener } from "@react-hookz/web/esm/useEventListener";

/**
 * Button to fix the firefox bug when the click event is triggered even if you don't
 * want to.
 */
const FixedButton = ({ children, onClick, disabled, className, title }) => {
  const mouseDownedRef = React.useRef(false);
  const buttonRef = React.useRef();

  // Fix while firefox triggers click event even if the mousedown event wasn't here
  useEventListener(window, "mouseup", () => {
    mouseDownedRef.current = false;
  });

  const handleClick = React.useCallback(
    (e) => {
      if (!mouseDownedRef.current) {
        return;
      }
      mouseDownedRef.current = false;
      if (disabled) {
        return;
      }
      if (onClick) {
        onClick(e);
      }
    },
    [disabled, onClick]
  );

  return (
    <button
      className={className}
      ref={buttonRef}
      disabled={disabled}
      onMouseUp={handleClick}
      onMouseDown={() => {
        mouseDownedRef.current = true;
      }}
      title={title}
    >
      {children}
    </button>
  );
};

export default FixedButton;
