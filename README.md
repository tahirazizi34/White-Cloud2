# White Cloud 2 website + inventory admin

Smoke shop site for White Cloud 2, 1252 S Walnut St #3, Starke, FL 32091.

## What's here
- `public/index.html`: the public website. Products load live from `/api/catalog`.
- `public/admin.html`: the staff inventory page at **/admin**.
- `server.js`: zero-dependency Node server (site + API + photo uploads).
- `seed/inventory.json`: starting product list, copied into the data folder on first run.

## Railway setup (one time)
1. **Variables** tab:
   - `ADMIN_PASSWORD`: the password staff type at /admin (use something long).
   - `SESSION_SECRET`: any long random string.
   - `DATA_DIR` = `/data`
2. **Add a Volume** to the service with mount path **/data**.
   Without a volume, inventory changes and uploaded photos are wiped on every redeploy.
3. Redeploy. Visit `https://your-site/admin` and log in.

## Using the admin
- **+ / −** next to a product changes the quantity and saves right away.
- Leave quantity blank for "not tracked" (no stock badge on the website).
- At or below the low-stock number, the site shows "Low stock". At 0 it shows "Out of stock".
- The switch hides or shows a product on the website without deleting it.
- Pick a single category in the filter to reorder products with the arrows.
- **Backup** downloads the whole inventory as a JSON file. Do this now and then.

## Run locally
```
ADMIN_PASSWORD=test npm start
```
Open http://localhost:3000 and http://localhost:3000/admin. Local data is saved in `./data`.
