# Holo Ticker: website

Track your Pokémon card collection in the browser. Upload a card photo, and Claude identifies it and estimates its grade. You get raw and graded prices (PSA 7–10, 9.5, BGS / CGC / SGC 10), a price chart for each card, and a "should I grade it?" answer after fees.

- `index.html` is the whole website, in one file.
- `server/` is a small server that keeps your Claude and PriceCharting keys secret.

Your card collection is saved **in the browser you use**, not on the server. Open the site on another device and you start with an empty collection.

---

## Part 1: Put the website on GitHub and get an address (no coding needed)

1. Sign in at **github.com** (create a free account if you don't have one).
2. Click **+** (top right) → **New repository**.
   - Repository name: `holo-ticker`
   - Choose **Public**. Free GitHub Pages needs a public repository.
   - Click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Drag in **everything from this folder**: `index.html`, `icon.png`, `README.md`, `.gitignore` and the `server` folder. Then click **Commit changes**.
5. Go to **Settings** → **Pages** (left sidebar).
   - Under **Build and deployment** → **Source**, pick **Deploy from a branch**.
   - **Branch:** `main`, folder `/ (root)`. Click **Save**.
6. Wait about a minute and refresh the page. GitHub shows your address:

   **`https://YOUR-USERNAME.github.io/holo-ticker/`**

That's the website's address. It loads right away, but it can't identify cards or fetch prices until you do Part 2.

> Never put your API keys in any file you upload to GitHub. With a public repository, anyone can read them. The keys go only into the server (Part 2).

### Using git on the command line instead

```bash
cd holo-ticker-web
git init
git add .
git commit -m "Holo Ticker website"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/holo-ticker.git
git push -u origin main
```

Then do step 5 above.

---

## Part 2: Set up the server (about 10 minutes, also no coding)

The website needs two paid keys:

- **Claude API key:** console.anthropic.com → API Keys. Pay per use, roughly a cent or two per photo.
- **PriceCharting API token:** a pricecharting.com subscription with API access.

The server runs free on Cloudflare.

1. Sign up at **dash.cloudflare.com** (free).
2. Go to **Workers & Pages** → **Create** → **Create Worker**. Name it `holo-ticker` and click **Deploy**.
3. Click **Edit code**. Delete everything in the editor, then paste the whole contents of `server/worker-paste-into-cloudflare.js`. Click **Deploy**.
4. Go back to the worker → **Settings** → **Variables and Secrets** → **Add**. Add these three, each with type **Secret**:

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Claude API key |
   | `PRICECHARTING_TOKEN` | your PriceCharting token |
   | `APP_KEY` | a long password you make up |

   Optional: add a plain-text variable `CLAUDE_MODEL` = `claude-sonnet-5-5` (the default).
5. Copy your worker's address, something like `https://holo-ticker.yourname.workers.dev`. Open `/health` on that address in your browser. It should show `{"ok":true}`.

If you prefer the command line, run this inside `server/`: `npm install`, `npx wrangler login`, `npx wrangler secret put ANTHROPIC_API_KEY` (and the same for the other two), then `npx wrangler deploy`.

---

## Part 3: Connect the website to your server

1. Open `https://YOUR-USERNAME.github.io/holo-ticker/`.
2. Scroll to the bottom and open **Settings: server and grading fees**.
3. Paste your worker address and your `APP_KEY`, then click **Save and test**. It should say **Connected**.
4. Upload a card photo. Done.

The server address and app key are saved only in your browser. They are not in the website files, so visitors to your GitHub page can't use your keys unless you give them the app key.

---

## Good to know

- **Prices** refresh when you open the page and every 30 minutes while it's open. Each refresh adds a point to the card's chart, so charts fill in over time.
- **Storage:** your collection lives in this browser. Clearing your browsing data deletes it. Browsers allow about 5 MB, which is room for roughly 150–200 cards with photos.
- **Price data license:** PriceCharting licenses its data for your own use. To run a public site showing their prices to other people, ask them about a commercial license.
- **Your own domain:** in GitHub → Settings → Pages → **Custom domain**, you can use a domain you own, like `holoticker.com`, instead of the github.io address.
- **Updating the site:** upload a new `index.html` to the repository (Add file → Upload files). GitHub Pages updates within a minute.
