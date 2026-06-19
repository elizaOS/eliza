document.addEventListener("DOMContentLoaded", () => {
  var URLofJsonFileContainingChecksums =
    "https://tails.net/install/v2/Tails/amd64/stable/latest.json";
  var sha256;

  /* Generic functions */

  function hide(elm) {
    elm.style.display = "none";
  }

  function show(elm) {
    elm.style.display = "initial";
    if (elm.classList.contains("display-as-block")) {
      elm.style.display = "block";
    }
    if (elm.classList.contains("display-as-inline-block")) {
      elm.style.display = "inline-block";
    }
  }

  function toggleDisplay(elm, mode) {
    for (let i = 0; i < elm.length; i++) {
      if (mode == "hide") {
        hide(elm[i]);
      } else {
        show(elm[i]);
      }
    }
  }

  function hitCounter(status) {
    try {
      var counter_url, url, scenario, version, cachebust;
      counter_url = "/install/download/counter";
      url = window.location.href.split("/");
      if (window.location.href.match(/\/upgrade\//)) {
        scenario = "upgrade";
      } else {
        scenario = url[url.lastIndexOf("install") + 1];
      }
      version = document
        .getElementById("tails-version")
        .textContent.replace("\n", "");
      cachebust = Math.round(new Date().getTime() / 1000);
      fetch(
        counter_url +
          "?scenario=" +
          scenario +
          "&version=" +
          version +
          "&status=" +
          status +
          "&cachebust=" +
          cachebust,
      );
    } catch (e) {} // Ignore if we fail to hit the download counter
  }

  /* Display logic functions */

  function showVerifyButton() {
    hide(document.getElementById("verifying-download"));
    show(document.getElementById("verify-button"));
  }

  function showVerifyingDownload(filename) {
    resetVerificationResult();
    hide(document.getElementById("verify-button"));
    if (filename) {
      var filenames = document.getElementsByClassName("verify-filename");
      for (let i = 0; i < filenames.length; i++) {
        filenames[i].textContent = filename;
      }
    }
    show(document.getElementById("verifying-download"));
  }

  function showVerificationProgress(percentage) {
    document.getElementById("progress-bar").style.width = percentage + "%";
    document
      .getElementById("progress-bar")
      .setAttribute("aria-valuenow", percentage.toString());
  }

  function showVerificationResult(result) {
    hide(document.getElementById("verify-button"));
    resetVerificationResult();
    hitCounter(result);
    if (result === "successful") {
      show(document.getElementById("verification-successful"));
    } else if (result === "failed") {
      show(document.getElementById("verification-failed"));
    } else if (result === "error-file") {
      show(document.getElementById("verification-error-file"));
    } else if (result === "error-json") {
      show(document.getElementById("verification-error-json"));
      document
        .getElementById("checksum-file")
        .setAttribute("href", URLofJsonFileContainingChecksums);
    } else if (result === "error-image") {
      show(document.getElementById("verification-error-image"));
    }
  }

  function resetVerificationResult(result) {
    showVerificationProgress(0);
    hide(document.getElementById("verifying-download"));
    hide(document.getElementById("verification-successful"));
    hide(document.getElementById("verification-failed"));
    hide(document.getElementById("verification-error-file"));
    hide(document.getElementById("verification-error-json"));
    hide(document.getElementById("verification-error-image"));
    show(document.getElementById("verification"));
  }

  /* Verification logic functions */

  async function verifyFile(e, elm) {
    try {
      file = elm.files[0];
      showVerifyingDownload(file.name);
    } catch (err) {
      showVerificationResult("error-file");
      return;
    }

    try {
      var response = await fetch(URLofJsonFileContainingChecksums);
      var checksumjson = await response.text();
    } catch (err) {
      showVerificationResult("error-json");
      return;
    }

    try {
      sha256 = forge.md.sha256.create();
      await readFile(file);
      var fileactualchecksum = sha256.digest().toHex();
    } catch (err) {
      showVerificationResult("error-image");
      return;
    }

    //If downloaded file is valid, then fileactualchecksum should be 64 hex characters in length, and should be contained within checksumjson.  Otherwise, consider downloaded file to be invalid.
    if (
      fileactualchecksum.length == 64 &&
      (checksumjson.includes(fileactualchecksum.toUpperCase()) ||
        checksumjson.includes(fileactualchecksum.toLowerCase()))
    ) {
      showVerificationResult("successful");
    } else {
      showVerificationResult("failed");
    }
  }

  async function readFile(file) {
    var CHUNK_SIZE = 2 * 1024 * 1024;
    var offset = 0;
    lastCalculatedPercentage = 0;
    while (true) {
      var chunk = await readChunk(file, offset, CHUNK_SIZE);
      sha256.update(chunk);
      offset += chunk.length;

      var progressPercent = parseInt((offset * 100.0) / file.size);
      if (progressPercent != lastCalculatedPercentage) {
        lastCalculatedPercentage = progressPercent;
        showVerificationProgress(progressPercent);
      }

      if (chunk.length < CHUNK_SIZE) {
        return;
      }
    }
  }

  function readChunk(file, chunk_offset, chunk_size) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = (e) => {
        resolve(e.target.result);
      };

      // on error, reject the promise
      fr.onerror = (e) => {
        reject(e);
      };
      const slice = file.slice(chunk_offset, chunk_offset + chunk_size);

      // This API is non-standard: https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsBinaryString
      // We use it for performance reasons, see #15059.
      fr.readAsBinaryString(slice);
    });
  }

  /* Initialize event handlers */

  // Direct download
  document.getElementById("download-img").onclick = function (e) {
    download(e, this);
  };
  document.getElementById("download-iso").onclick = function (e) {
    download(e, this);
  };

  // Download again after failure
  document.getElementById("download-img-again").onclick = function (e) {
    download(e, this);
  };
  document.getElementById("download-iso-again").onclick = function (e) {
    download(e, this);
  };

  function download(e, elm) {
    resetVerificationResult();
    showVerifyButton();
  }

  // Trigger verification when file is chosen
  document.getElementById("verify-file").onchange = function (e) {
    verifyFile(e, this);
  };

  // Retry after error during verification
  document.getElementById("retry-json").onclick = (e) => {
    resetVerificationResult();
    showVerifyButton();
  };
  document.getElementById("retry-image").onclick = (e) => {
    resetVerificationResult();
    showVerifyButton();
  };

  // Display elements of the JavaScript version
  toggleDisplay(document.getElementsByClassName("no-js"), "hide");
  show(document.getElementById("download-img"));
  show(document.getElementById("download-iso"));

  // Internet Explorer
  if (
    navigator.userAgent.indexOf("MSIE") > -1 ||
    navigator.userAgent.indexOf("Trident") > -1
  ) {
    show(document.getElementById("ie"));
  } else {
    showVerifyButton();
  }

  // To debug the display of the different states:
  // showVerifyingDownload("test.img");
  // showVerificationProgress("50");
  // showVerificationResult("successful");
  // showVerificationResult("failed");
  // showVerificationResult("error-json");
  // showVerificationResult("error-image");
  // verifyFile(null, null);
});
