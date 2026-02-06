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
          name="label"
          component="input"
          initialValue={initialValues.label}
        />
      </Label>

      <Label>
        {t("Color")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>
    </>
  );
};

export default Form;
