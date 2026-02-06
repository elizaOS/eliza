import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";

const Form = ({ name, initialValues = { layer: 0 } }) => {
  const { t } = useTranslation();
  return (
    <>
      <Label>
        {t("Layer to change")}
        <Field
          name={`${name}.layer`}
          component="input"
          parse={(value) => parseInt(value, 10) || 0}
          initialValue={initialValues.layer}
        />
      </Label>
    </>
  );
};

export default Form;
