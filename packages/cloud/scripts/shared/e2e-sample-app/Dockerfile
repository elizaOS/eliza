# Sample user app for the Apps/Product 2 end-to-end proof. FROM postgres:16-alpine
# so it ships psql (to reach its tenant DB) + busybox nc (to serve its URL) with
# zero extra image pulls. A real user app would be any web server + DB client.
FROM postgres:16-alpine
COPY server.sh /usr/local/bin/server.sh
RUN chmod +x /usr/local/bin/server.sh
ENV PORT=3000
# Drop the postgres image's entrypoint so our server runs directly.
ENTRYPOINT []
CMD ["/usr/local/bin/server.sh"]
