# Device keys

One device's key, from the approval that issues its one-time code to the
end of the key. A signed-in session connects a registered client (`POST
/api/v1/app-auth/connect`) and gets a code `emac_` + 64 hex that lives five
minutes; the device exchanges it with its PKCE verifier (`POST
/api/v1/app-auth/mobile/token`) for a key `eliza_mobile_` + 64 hex, and
acknowledges the key once it has stored it (`POST
/api/v1/app-auth/mobile/ack`). Only an acknowledged key is ever accepted, and
it is renewed only by its device lease (`identity/sessions`): `POST
/api/v1/app-auth/mobile/renew` with `Authorization: Bearer <lease refresh>`
mints its successor, and any other new key needs a new sign-in. `DELETE
/api/v1/api-keys/current` ends the presenting key and its lease. The device's own Google
