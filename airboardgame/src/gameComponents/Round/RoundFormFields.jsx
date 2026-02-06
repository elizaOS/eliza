import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";

import ColorPicker from "../../ui/formUtils/ColorPicker";

const Form = ({ initialValues }) => {
  const { t } = useTranslation();
  return (
    <>
      <Label>
        {t("Label")}
        <Field
          name="text"
          component="input"
          initialValue={initialValues.text}
        />
      </Label>
      <Label>
        {t("Radius")}
        <Field
          name="radius"
          component="input"
          initialValue={initialValues.radius}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Color")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={false}
            />
          )}
        </Field>
      </Label>

      <Label>
        {t("Flipped color")}
        <Field
          name="flippedColor"
          component="input"
          initialValue={initialValues.flippedColor}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>

      <Label>
        {t("Font size")}
        <Field
          name="fontSize"
          component="input"
          initialValue={initialValues.fontSize || 16}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Text color")}
        <Field
          name="textColor"
          component="input"
          initialValue={initialValues.textColor || "#000"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={true}
            />
          )}
        </Field>
      </Label>
    </>
  );
};

export default Form;
