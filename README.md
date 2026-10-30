# GHL Lender Log

When the **Lenders** checkbox field changes on a contact, this service:

1. Reads which lenders are checked
2. Adds one line per lender to a log field, stamped with date and time
3. Clears the Lenders checkbox
4. Adds a note to the contact with the same shop-out, so it shows in the timeline

Example note:

```
Lender shop-out - 10/07/26 09:42 EDT
- Fundfi
- Rapid Finance
```

Example log field after two submissions:

```
10/07/26 14:15 EDT - Kapitus
10/07/26 09:42 EDT - Fundfi
10/07/26 09:42 EDT - Rapid Finance
```

The GHL token and location ID come in with each webhook, so one Railway deploy
serves every sub-account. No Railway variables are required.

## Setup in each sub-account

1. Make sure the checkbox field is named **Lenders**.
2. Create a **Large Text** contact custom field named **Lender Submission Log**.
3. Create a Private Integration token with these scopes: View Contacts, Edit Contacts, View Custom Fields.
4. Create a workflow:
   - **Trigger:** Contact Changed, filter: Lenders *has changed*. Add a second filter, Lenders *is not empty*, if the trigger offers it.
   - **Action:** Webhook, method POST, URL `https://YOUR-APP.up.railway.app/webhook`
   - **Custom data:** `ghl_token` = the Private Integration token
   - Turn on **Allow re-entry** in workflow settings so it runs every time the field changes.

GHL's webhook action already sends `contact_id` and the location ID
(`location.id`) in its standard payload, so `ghl_token` is the only custom data
you have to add.

## What the webhook can send

| Key | Required | Notes |
| --- | --- | --- |
| `ghl_token` | Yes | Also accepted as `token` |
| `location_id` | Yes | Read from `location.id` automatically if not sent |
| `contact_id` | Yes | Sent automatically by GHL |
| `lenders_field_id`, `log_field_id` | No | Send the field IDs directly and the name lookup is skipped |
| `lenders_field`, `log_field` | No | Different field names for this sub-account |
| `timezone` | No | For example `America/Chicago` |
| `add_note` | No | `false` turns the contact note off for this sub-account |

Keys can sit in the webhook's custom data or at the top level of the body.

## Optional Railway variables

| Variable | Default |
| --- | --- |
| `LENDERS_FIELD_NAME` | `Lenders` |
| `LOG_FIELD_NAME` | `Lender Submission Log` |
| `TIMEZONE` | `America/New_York` |
| `NEWEST_FIRST` | `true`. Set `false` to add new lines at the bottom |
| `ADD_NOTE` | `true`. Set `false` to stop adding contact notes everywhere |
| `WEBHOOK_SECRET` | Not set. If set, the webhook must send it in an `x-webhook-secret` header |

## Notes

- Clearing the checkbox fires the workflow a second time. The service sees an empty field and does nothing, so there is no loop.
- The log write and the clear happen in one API request. If GHL rejects it, the checkbox stays as it was and nothing is lost.
- The note is added after the log is saved. If the note fails, the log and the clear still stand; the error is logged and returned as `noteError`.
- If a sub-account has no field with the expected name, the webhook returns an error naming the missing field and leaves the checkbox alone.
- Tokens are used for the request and never written to the logs or stored.
- `GET /` returns `ghl-lender-log ok` for a quick health check.
