FROM openphone/chipyard-base-amd64:1.13.0

SHELL ["/bin/bash", "-lc"]

ARG CIRCT_VERSION=firtool-1.75.0
ARG CIRCT_ARCHIVE=circt-full-static-linux-x64.tar.gz

RUN conda install -y -n base -c conda-forge -c ucb-bar \
      make \
      jq \
      wget \
      openjdk=20 \
      sbt=1.10.1 \
      verilator=5.022 \
      riscv-tools && \
    conda clean -afy

RUN mkdir -p /opt/openphone/circt && \
    wget -O - "https://github.com/llvm/circt/releases/download/${CIRCT_VERSION}/${CIRCT_ARCHIVE}" | \
      tar -zx -C /opt/openphone/circt --strip-components 1

ENV RISCV=/opt/conda/riscv-tools
ENV PATH=/opt/openphone/circt/bin:/opt/conda/riscv-tools/bin:/opt/conda/bin:/opt/conda/condabin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN java -version && \
    command -v sbt && \
    verilator --version && \
    firtool --version && \
    test -x "$RISCV/bin/riscv64-unknown-elf-gcc"
