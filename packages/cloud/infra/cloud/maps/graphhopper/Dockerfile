# GraphHopper routing server for Eliza Cloud Maps. The jar is fetched from
# Maven Central and must match the digest the operator reviewed.
FROM eclipse-temurin:21-jre

ARG GRAPHHOPPER_VERSION=10.2
ARG GRAPHHOPPER_SHA256
RUN test -n "${GRAPHHOPPER_SHA256}" || { echo "GRAPHHOPPER_SHA256 is required" >&2; exit 1; }

ADD https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar /opt/graphhopper/graphhopper.jar
RUN echo "${GRAPHHOPPER_SHA256}  /opt/graphhopper/graphhopper.jar" | sha256sum -c - \
	&& useradd --system --uid 10001 --home-dir /opt/graphhopper graphhopper \
	&& mkdir -p /graph-cache \
	&& chown graphhopper /graph-cache

COPY config.yml /opt/graphhopper/config.yml

USER graphhopper
EXPOSE 8989
ENTRYPOINT ["sh", "-c", "exec java ${JAVA_OPTS:--Xmx2g} -jar /opt/graphhopper/graphhopper.jar server /opt/graphhopper/config.yml"]
