import React from "react";
import recoil from "recoil";
import whyDidYouRender from "@welldone-software/why-did-you-render";

if (import.meta.env.DEV && !import.meta.env.VITE_DISABLE_WDYR) {
  console.log("Activate WDYR...");
  whyDidYouRender(React, {
    trackAllPureComponents: true,
    //logOwnerReasons: true,
    trackExtraHooks: [
      [recoil, "useRecoilState", "useRecoilValue", "useSetRecoilState"],
    ],
  });
}
