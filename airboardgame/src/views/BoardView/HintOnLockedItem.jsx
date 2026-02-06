import React from "react";
import { toast } from "react-toastify";
import { useTranslation } from "react-i18next";

import { hasClass } from "../../utils";
import { useItemActions } from "react-sync-board";

const HintOnLockedItem = () => {
  const { findElementUnderPointer } = useItemActions();

  const { t } = useTranslation();

  const onDblClick = React.useCallback(
    async (e) => {
      const foundElement = await findElementUnderPointer(e, {
        returnLocked: true,
      });

      if (foundElement && hasClass(foundElement, "locked")) {
        toast.info(t("Long click to select locked elements"));
      }
    },
    [findElementUnderPointer, t]
  );

  React.useEffect(() => {
    document.addEventListener("dblclick", onDblClick);
    return () => {
      document.removeEventListener("dblclick", onDblClick);
    };
  }, [onDblClick]);

  return null;
};

export default HintOnLockedItem;
