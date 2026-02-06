import React from "react";
import { useTranslation } from "react-i18next";

import i18n from "../i18n";
import { ImageField, media2Url } from "../mediaLibrary";

import ColorPicker from "../ui/formUtils/ColorPicker";

const defaultBgColor = "#19202c";

const defaultSecondaryColor = "rgba(255,255,255,0.2)";

const drawToDataURL = (width, height, draw) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  draw(ctx);
  return canvas.toDataURL();
};

const ColorBgForm = ({ value, onChange }) => {
  const { t } = useTranslation();

  const onColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const onSecondaryColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const valueWithDefault = Object.assign(
    {
      color: defaultBgColor,
      secondaryColor: defaultSecondaryColor,
    },
    value
  );

  return (
    <>
      <label>
        {t("Color")}
        <ColorPicker value={valueWithDefault.color} onChange={onColorChange} />
      </label>
      <label>
        {t("Secondary color")}
        <ColorPicker
          value={valueWithDefault.secondaryColor}
          disableAlpha={false}
          onChange={onSecondaryColorChange}
        />
      </label>
    </>
  );
};

const GridBgForm = ({ value, onChange }) => {
  const { t } = useTranslation();

  const onColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const onLineColorChange = (clr) => {
    onChange({ ...value, secondaryColor: clr });
  };

  const onLineWidthChange = (event) => {
    let lineWidth = parseInt(event.target.value, 10);
    if (isNaN(lineWidth)) {
      lineWidth = null;
    } else {
      if (lineWidth < 1) {
        lineWidth = 1;
      }
      if (lineWidth > 200) {
        lineWidth = 200;
      }
    }
    onChange({ ...value, thickness: lineWidth });
  };

  const onGridSizeChange = (event) => {
    let gridSize = parseInt(event.target.value, 10);
    console.log(gridSize, event.target.value);
    if (isNaN(gridSize)) {
      gridSize = null;
    } else {
      if (gridSize < 1) {
        gridSize = 1;
      }
    }
    onChange({ ...value, size: gridSize });
  };

  const valueWithDefault = Object.assign(
    {
      size: 200,
      thickness: 4,
      color: defaultBgColor,
      secondaryColor: defaultSecondaryColor,
    },
    value
  );

  return (
    <>
      <label>
        {t("Bg color")}
        <ColorPicker value={valueWithDefault.color} onChange={onColorChange} />
      </label>
      <label>
        {t("Line color")}
        <ColorPicker
          value={valueWithDefault.secondaryColor}
          disableAlpha={false}
          onChange={onLineColorChange}
        />
      </label>
      <label>
        {t("Grid size")}
        <input
          type="number"
          value={valueWithDefault.size}
          onChange={onGridSizeChange}
        />
      </label>
      <label>
        {t("Line thickness")}
        <input
          type="number"
          value={valueWithDefault.thickness}
          onChange={onLineWidthChange}
        />
      </label>
    </>
  );
};

const DotBgForm = ({ value, onChange }) => {
  const { t } = useTranslation();

  const onColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const onDotColorChange = (clr) => {
    onChange({ ...value, secondaryColor: clr });
  };

  const onDotSizeChange = (event) => {
    let dotSize = parseInt(event.target.value, 10);
    if (isNaN(dotSize)) {
      dotSize = null;
    } else if (dotSize < 1) {
      dotSize = 1;
    }
    onChange({ ...value, secondarySize: dotSize });
  };

  const onDotDistanceChange = (event) => {
    let dotDistance = parseInt(event.target.value, 10);
    if (isNaN(dotDistance)) {
      dotDistance = null;
    } else if (dotDistance < 1) {
      dotDistance = 1;
    }
    onChange({ ...value, size: dotDistance });
  };

  const valueWithDefault = Object.assign(
    {
      color: defaultBgColor,
      secondaryColor: defaultSecondaryColor,
      size: 200,
      secondarySize: 100,
    },
    value
  );

  return (
    <>
      <label>
        {t("Bg color")}
        <ColorPicker value={valueWithDefault.color} onChange={onColorChange} />
      </label>
      <label>
        {t("Dot color")}
        <ColorPicker
          value={valueWithDefault.secondaryColor}
          disableAlpha={false}
          onChange={onDotColorChange}
        />
      </label>
      <label>
        {t("Dot distance")}
        <input
          type="number"
          value={valueWithDefault.size}
          onChange={onDotDistanceChange}
        />
      </label>
      <label>
        {t("Dot size")}
        <input
          type="number"
          value={valueWithDefault.secondarySize}
          onChange={onDotSizeChange}
        />
      </label>
    </>
  );
};

const SquareBgForm = ({ value, onChange }) => {
  const { t } = useTranslation();

  const onColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const onSquareColorChange = (clr) => {
    onChange({ ...value, secondaryColor: clr });
  };

  const onSquareSizeChange = (event) => {
    let squareSize = parseInt(event.target.value, 10);
    if (isNaN(squareSize)) {
      squareSize = null;
    } else if (squareSize < 1) {
      squareSize = 1;
    }
    onChange({ ...value, secondarySize: squareSize });
  };

  const onSquareDistanceChange = (event) => {
    let squareDistance = parseInt(event.target.value, 10);
    if (isNaN(squareDistance)) {
      squareDistance = null;
    } else if (squareDistance < 1) {
      squareDistance = 1;
    }
    onChange({ ...value, size: squareDistance });
  };

  const valueWithDefault = Object.assign(
    {
      color: defaultBgColor,
      secondaryColor: defaultSecondaryColor,
      size: 200,
      secondarySize: 100,
    },
    value
  );

  return (
    <>
      <label>
        {t("Bg color")}
        <ColorPicker value={valueWithDefault.color} onChange={onColorChange} />
      </label>
      <label>
        {t("Square color")}
        <ColorPicker
          value={valueWithDefault.secondaryColor}
          disableAlpha={false}
          onChange={onSquareColorChange}
        />
      </label>
      <label>
        {t("Square distance")}
        <input
          type="number"
          value={valueWithDefault.size}
          onChange={onSquareDistanceChange}
        />
      </label>
      <label>
        {t("Square size")}
        <input
          type="number"
          value={valueWithDefault.secondarySize}
          onChange={onSquareSizeChange}
        />
      </label>
    </>
  );
};

const CustomBgForm = ({ value, onChange }) => {
  const { t } = useTranslation();

  const onImageChange = (imgVal) => {
    onChange({ ...value, img: imgVal });
  };
  const onColorChange = (clr) => {
    onChange({ ...value, color: clr });
  };

  const valueWithDefault = Object.assign(
    {
      color: defaultBgColor,
    },
    value
  );

  return (
    <>
      <label>
        {t("Color")}
        <ColorPicker value={valueWithDefault.color} onChange={onColorChange} />
      </label>
      <label>
        {t("Image")}
        <ImageField value={valueWithDefault.img} onChange={onImageChange} />
      </label>
    </>
  );
};

const backgrounds = [
  {
    type: "default",
    name: i18n.t("Default"),
    form: null,
    getStyle() {
      const color = "#2c3749";
      const thickness = 4;
      const secondaryColor = defaultSecondaryColor;
      const size = 200;
      const dataUrl = drawToDataURL(size, size, (ctx) => {
        ctx.lineWidth = thickness;
        ctx.strokeStyle = secondaryColor;
        ctx.beginPath();
        ctx.moveTo(size, 2);
        ctx.lineTo(2, 2);
        ctx.lineTo(2, size);
        ctx.stroke();
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "grid",
    name: i18n.t("Grid"),
    form: GridBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
      thickness = 4,
      size = 200,
    } = {}) {
      // Create grid background
      const dataUrl = drawToDataURL(size, size, (ctx) => {
        ctx.lineWidth = thickness;
        ctx.strokeStyle = secondaryColor;
        ctx.beginPath();
        ctx.moveTo(size, 2);
        ctx.lineTo(2, 2);
        ctx.lineTo(2, size);
        ctx.stroke();
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "dot",
    name: i18n.t("Dot"),
    form: DotBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
      secondarySize = 100,
      size = 200,
    } = {}) {
      const dataUrl = drawToDataURL(size, size, (ctx) => {
        ctx.fillStyle = secondaryColor;
        ctx.beginPath();
        ctx.arc(
          secondarySize / 2,
          secondarySize / 2,
          secondarySize / 2,
          0,
          2 * Math.PI
        );
        ctx.fill();
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "square",
    name: i18n.t("Square"),
    form: SquareBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
      secondarySize = 50,
      size = 100,
    } = {}) {
      const dataUrl = drawToDataURL(size, size, (ctx) => {
        ctx.fillStyle = secondaryColor;
        ctx.fillRect(0, 0, secondarySize, secondarySize);
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "hstripe",
    name: i18n.t("Horizontal Stripe"),
    form: ColorBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
    } = {}) {
      const dataUrl = drawToDataURL(200, 200, (ctx) => {
        ctx.fillStyle = secondaryColor;
        ctx.fillRect(0, 0, 200, 100);
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "vstripe",
    name: i18n.t("Vertical Stripe"),
    form: ColorBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
    } = {}) {
      const dataUrl = drawToDataURL(200, 200, (ctx) => {
        ctx.fillStyle = secondaryColor;
        ctx.fillRect(0, 0, 100, 200);
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "xstripe",
    name: i18n.t("Crossed stripes"),
    form: ColorBgForm,
    getStyle({
      color = defaultBgColor,
      secondaryColor = defaultSecondaryColor,
    } = {}) {
      const dataUrl = drawToDataURL(200, 200, (ctx) => {
        ctx.fillStyle = secondaryColor;
        ctx.fillRect(0, 0, 100, 200);
        ctx.fillRect(0, 0, 200, 100);
      });
      return {
        backgroundColor: color,
        backgroundImage: `url(${dataUrl})`,
      };
    },
  },
  {
    type: "custom",
    name: i18n.t("Custom"),
    form: CustomBgForm,
    getStyle({ color = defaultBgColor, img = {} } = {}) {
      const style = {
        backgroundColor: color,
      };
      if (img?.type) {
        const url = media2Url(img);
        if (url) {
          style.backgroundImage = `url(${url})`;
        }
      }
      return style;
    },
  },
];

export default backgrounds;
