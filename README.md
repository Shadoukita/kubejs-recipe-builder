# KubeJS Recipe Builder

> A visual, modular recipe editor for **KubeJS** – with first-class support for **Vanilla** and the **Create** mod, plus a flexible `event.custom` editor for anything else.  
> Target: **NeoForge** • **Minecraft 1.21.1** • **KubeJS 2101.7.1-build.181**

---

## ✨ Features

- **Vanilla adapters**
  - Shaped crafting (auto-trim pattern + key generation)
  - Shapeless crafting (up to 9 inputs)
  - Smelting/Furnace (optional XP + cook time)
- **Create mod adapters**
  - Milling, Crushing, Mixing (with `heated` / `superheated`)
  - Pressing, Cutting, Deploying (**Keep Hand** toggle supported)
  - Filling, Emptying
  - Fan Processing: Splashing, Smoking, Blasting (Fan), Haunting
  - Compacting (with heat)
  - Mechanical Crafting (pattern + key editor)
  - **Sequenced Assembly** (loops, transitional item, step editor incl. pressing/cutting/deploying/spouting/emptying/custom)
- **Custom module**
  - Generic `event.custom` with free-form **type**, item/fluids, results, and extra JSON merge
- **Smart input handling**
  - Vanilla inputs always treated as **1x** (no count prompts)
  - For Create JSON, ingredient `count > 1` is expanded into repeated ingredient entries (as the game expects)
- **Helpful UX**
  - Validation messages before adding to project
  - One global **Recipe ID** per entry (auto-prefixed `shadoukube:{id}`)
  - Copy or download generated `/kubejs/server_scripts/recipes.js`
  - Tip: Press **F3 + H** in Minecraft to show item IDs & tags in tooltips

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+**
- **npm** (or pnpm/yarn)

### Install & Run
```bash
git clone https://github.com/Shadoukita/kubejs-recipe-builder.git
cd kubejs-recipe-builder
npm install
npm run dev
```
Open the local URL shown in your terminal.

### Build (optional for local preview / CI)
```bash
npm run build
npm run preview
```

---

## 🧭 How to Use

1. Pick a **mod** (Vanilla / Create / Custom) and an **adapter**.
2. Fill out the fields.  
   - For Create’s **Deploying**, use **Keep Hand** to keep the held item (not consumed).  
   - For **Sequenced Assembly**, set **loops**, **transitional** item, and add steps.
3. Enter a unique **Recipe ID** (bottom of the editor).
4. **Add to Project** → your recipe appears in the list with the generated KubeJS code.
5. Copy or **save** `recipes.js` and place it into:
   ```
   kubejs/server_scripts/recipes.js
   ```


---

## 🧩 Extending the Builder

Adapters implement:

```ts
interface RecipeAdapter<TPayload> {
  id: string;
  title: string;
  icon?: React.ReactNode;
  defaults: TPayload;
  Editor: React.FC<{ value: TPayload; onChange: (v: TPayload) => void; itemPalette: string[] }>;
  validate(payload: TPayload): { level: 'error'|'warn'; msg: string }[];
  toKubeJS(payload: TPayload): string[];
}
```

Register your adapter inside a **ModPlugin** and add it to the `PLUGINS` array.

---

## 🛠️ Troubleshooting

- **Unknown registry key** (e.g. `minecraft:wheat_seads`)  
  → Typo in the item ID. Use **F3 + H** in Minecraft to show accurate IDs (e.g. `minecraft:wheat_seeds`).

- **Create JSON errors** like “No key `type`” or “Not a JSON array”  
  → Some Create steps expect specific schemas. Use the built-in adapters; the builder outputs correct shapes (e.g. `ingredients` arrays, `{ id, count }` results, `transitional_item` key in sequenced assembly).

- **Vanilla ingredient counts**  
  → Vanilla crafting/furnace **do not** support counts on ingredients. The builder handles this by expanding counts where needed (Create JSON) and by forcing 1x where vanilla requires it.

---

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the LICENSE.txt file for details.

---

