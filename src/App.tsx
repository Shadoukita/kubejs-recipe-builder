import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Copy, Download, Plus, Trash2, Wrench, Hammer, Cog, Layers, Flame, Braces, Sun, Moon} from "lucide-react";



// ------------------------------------------------------------
// KubeJS Recipe Builder – Modular by Mod
// Extensible via Mod Plugins -> each plugin contributes recipe adapters
// ------------------------------------------------------------

// ---------- Types ----------

type Platform = "NeoForge" | "Fabric" | "Forge";

type ItemLike = {
  id: string;          // e.g. "minecraft:iron_ingot" or "minecraft:gold_ingot"
  count?: number;      // default 1
  nbt?: string;        // optional NBT as raw JSON string
};

// Welche Step-Typen unterstützen wir direkt im UI?
type SeqStepKind = 'pressing' | 'cutting' | 'deploying' | 'spouting' | 'emptying' | 'custom';

type SeqPressingStep = {
  kind: 'pressing';
  processingTime?: number;
  autoTransitionalResult?: boolean; // true => Ergebnis ist automatisch das Transitional Item
};

type SeqCuttingStep = {
  kind: 'cutting';
  processingTime?: number;
  autoTransitionalResult?: boolean;
};

type SeqDeployingStep = {
  kind: 'deploying';
  addition: ItemLike | null;        // das "obere" Item, das auf das Transitional gedrückt wird
  keepHeldItem?: boolean;           // verbraucht es sich oder bleibt es in der Hand?
  autoTransitionalResult?: boolean;
};

type SeqSpoutingStep = {
  kind: 'spouting';
  fluid: FluidLike | null;          // { fluid, amount (mb) }
  autoTransitionalResult?: boolean;
};

type SeqEmptyingStep = {
  kind: 'emptying';
  // selten genutzt in Sequenzen; Standard = Transitional zurück
  autoTransitionalResult?: boolean;
};

type SeqCustomStep = {
  kind: 'custom';
  type: string;                      // frei: z. B. "create:deploying", "modid:step_type", ...
  includeTransitional?: boolean;     // Transitional automatisch als erstes Ingredient?
  ingredients: (ItemLike | null)[];  // extra Item-Zutaten
  fluids?: (FluidLike | null)[];     // extra Fluids
  results?: ItemLike[];              // falls autoTransitionalResult=false oder du custom Result willst
  processingTime?: number;
  autoTransitionalResult?: boolean;
};

type SeqStep = SeqPressingStep | SeqCuttingStep | SeqDeployingStep | SeqSpoutingStep | SeqEmptyingStep | SeqCustomStep;

type SequencedPayload = {
  input: ItemLike | null;           // Start-Ingredient (wird zu Transitional verarbeitet)
  transitional: ItemLike;           // create:incomplete_… Item
  loops?: number;                   // wie oft durchlaufen
  steps: SeqStep[];                 // die Abfolge
  results: OutputLike[];            // finale Ergebnisse (mit chance)
  recipeId?: string;
};


type OutputLike = ItemLike & { chance?: number }; // 0..1

// Generic recipe payloads per adapter
interface RecipeAdapter<TPayload> {
  id: string;                   // namespaced: e.g. "vanilla.shaped", "create.milling"
  title: string;                // UI label
  icon?: React.ReactNode;       // optional icon
  defaults: TPayload;           // default payload when new
  Editor: React.FC<{
    value: TPayload;
    onChange: (next: TPayload) => void;
    itemPalette: string[];      // simple palette of item ids
  }>;
  validate: (payload: TPayload) => { level: "error" | "warn"; msg: string }[];
  toKubeJS: (payload: TPayload) => string[]; // emit lines
}

interface ProjectRecipe<T = any> {
  id: string;
  type: string;              // adapter id
  payload: T;
  label?: string;
}

// Mod Plugin groups adapters by mod (Create, Mystical Agriculture, etc.)
interface ModPlugin {
  id: string;         // e.g. "vanilla", "create", "mysticalagriculture"
  title: string;      // UI name
  adapters: RecipeAdapter<any>[];
}


// ---------- Utility helpers ----------

const uid = () => Math.random().toString(36).slice(2, 10);
const deepClone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const tagPayload = <T,>(type: string, payload: T): T & { __type: string } => ({ __type: type, ...(deepClone(payload) as any) });

const cleanItem = (i?: Partial<ItemLike> | null): ItemLike | null => {
  if (!i || !i.id?.trim()) return null;
  return { id: i.id.trim(), count: Math.max(1, i.count ?? 1), nbt: i.nbt?.trim() || undefined };
};

const itemToKube = (i: ItemLike): string => {
  const base = `${i.count && i.count !== 1 ? `${i.count}x ` : ""}${i.id}`;
  if (i.nbt && i.nbt.trim().length > 0) {
    return `Item.of('${base.replace(/'/g, "\\'")}', ${i.nbt})`;
  }
  if (i.id.startsWith('#') && (i.count ?? 1) !== 1) {
    return `Item.of('${i.id.replace(/'/g, "\\'")}', ${i.count ?? 1})`;
  }
  return `'${base.replace(/'/g, "\\'")}'`;
};

const outputToKube = (o: OutputLike): string => {
  const base = itemToKube(o);
  if (typeof o.chance === 'number' && !Number.isNaN(o.chance) && o.chance >= 0 && o.chance < 1) {
    if (base.startsWith("Item.of(")) return `${base}.withChance(${o.chance})`;
    return `Item.of(${base}).withChance(${o.chance})`;
  }
  return base;
};

// --- Fluids + helpers (Create JSON expects { fluid, amount }) ---
type FluidLike = { id: string; amount: number };

const cleanFluid = (f?: Partial<FluidLike> | null): FluidLike | null => {
  if (!f || !f.id?.trim()) return null;
  return { id: f.id.trim(), amount: Math.max(1, f.amount ?? 1) };
};

const fluidToJson = (f: FluidLike) => ({ fluid: f.id, amount: Math.max(1, f.amount | 0) });

// Expand item counts to repeated ingredient entries (no count on ingredient)
const expandItemsToJson = (items: (ItemLike | null)[]) => {
  const out: any[] = [];
  for (const raw of items.filter(Boolean) as ItemLike[]) {
    const times = Math.max(1, raw.count ?? 1);
    for (let i = 0; i < times; i++) out.push(itemToJson({ ...raw, count: 1 }));
  }
  return out;
};

// Result object for Create recipes that want { item, count } (e.g., mechanical_crafting)
const resultObjForCreate = (res: ItemLike) => {
  const o: any = { item: res.id };
  if ((res.count ?? 1) !== 1) o.count = res.count;
  const nbt = parseNbt(res.nbt);
  if (nbt) o.nbt = nbt;
  return o;
};

// Transitional als { item, nbt }
const transitionalObj = (it: ItemLike) => {
  const o: any = { item: it.id };
  const nbt = parseNbt(it.nbt);
  if (nbt) o.nbt = nbt;
  return o;
};

// Results für Sequenzen stets im { item }-Stil (Create erwartet hier i. d. R. "item")
const outputToCreateItemObj = (o: ItemLike) => {
  const res: any = { item: o.id };
  if ((o.count ?? 1) !== 1) res.count = o.count;
  const nbt = parseNbt(o.nbt);
  if (nbt) res.nbt = nbt;
  return res;
};

// Use for ANY "results" array in Create JSON (expects { id, count?, nbt?, chance? }).
const asResultId = (i: ItemLike | OutputLike) => {
  const o: any = { id: i.id };
  if ((i as any).count && (i as any).count !== 1) o.count = (i as any).count;
  const nbt = parseNbt((i as any).nbt);
  if (nbt) o.nbt = nbt;
  if (typeof (i as any).chance === 'number') o.chance = (i as any).chance;
  return o;
};

// Transitional as a *result* object (id form)
const transitionalResult = (it: ItemLike) => asResultId(it);

// Transitional as an *ingredient* object (item/tag form) — you already have this as transitionalObj/itemToJson
const transitionalIngredient = (it: ItemLike) => ({ item: it.id });



// --- JSON helpers for event.custom ---

const parseNbt = (s?: string) => {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
};

const itemToJson = (i: ItemLike) => {
  const base: any = i.id.startsWith('#') ? { tag: i.id.slice(1) } : { item: i.id };
  const nbt = parseNbt(i.nbt);
  // Vanilla-JSON unterstützt Mengen bei Zutaten nicht (außer Ergebnis).
  if (!i.id.startsWith('#') && i.count && i.count !== 1) base.count = i.count;
  if (nbt) base.nbt = nbt;
  return base;
};

const outputToJson = (o: OutputLike) => {
  const base: any = { id: o.id }; // gemäß deinem Beispiel "id" statt "item"
  if (o.count && o.count !== 1) base.count = o.count;
  if (typeof o.chance === 'number' && o.chance >= 0 && o.chance < 1) base.chance = o.chance;
  const nbt = parseNbt(o.nbt);
  if (nbt) base.nbt = nbt;
  return base;
};

// Für KubeJS-Inputs: count>1 als Duplikate (kein "count" in Zutaten)
const expandIngredientsToKube = (items: (ItemLike | null)[]) => {
  const out: string[] = [];
  for (const raw of items.filter(Boolean) as ItemLike[]) {
    const times = Math.max(1, raw.count ?? 1);
    for (let i = 0; i < times; i++) {
      out.push(itemToKube({ ...raw, count: 1 })); // count absichtlich 1
    }
  }
  return out;
};


// Zutaten mit count>1 in einzelne Einträge aufspalten (ohne "count" Property)
const expandForIngredients = (items: (ItemLike | null)[]) => {
  const out: any[] = [];
  for (const raw of items.filter(Boolean) as ItemLike[]) {
    const times = Math.max(1, raw.count ?? 1);
    for (let i = 0; i < times; i++) {
      // count absichtlich auf 1 setzen, damit itemToJson KEIN "count" schreibt
      out.push(itemToJson({ ...raw, count: 1 }));
    }
  }
  return out;
};


// Erzwingt Minecraft-kompatiblen path-part und entfernt ein evtl. mitgeschriebenes Prefix
const normalizeRecipeSuffix = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^shadoukube:/, "")            // falls Nutzer shadoukube: tippt
    .replace(/[^a-z0-9/_\-.]/g, "-")        // sichere Zeichen
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");         // leading/trailing Trennzeichen abwerfen


const Label: React.FC<{ children: React.ReactNode }>
  = ({ children }) => <label className="text-sm font-medium opacity-80">{children}</label>;

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input {...props} className={`border rounded-xl px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-indigo-300 ${props.className || ''}`} />
);

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = (props) => (
  <select {...props} className={`border rounded-xl px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 ${props.className || ''}`} />
);

const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" | "outline" }>
  = ({ variant = "solid", className, ...rest }) => {
  const base = "px-3 py-2 rounded-xl text-sm flex items-center gap-2 transition shadow-sm";
  const variants: Record<string, string> = {
    solid: "bg-indigo-600 text-white hover:bg-indigo-700",
    ghost: "bg-transparent hover:bg-gray-100",
    outline: "border hover:bg-gray-50",
  };
  return <button {...rest} className={`${base} ${variants[variant]} ${className || ''}`} />
};

const Pill: React.FC<{ children: React.ReactNode; active?: boolean; onClick?: () => void }>
  = ({ children, active, onClick }) => (
  <button onClick={onClick} className={`px-3 py-1 rounded-full text-xs border ${active ? 'bg-indigo-600 text-white' : 'bg-white hover:bg-gray-50'}`}>
    {children}
  </button>
);

const Section: React.FC<{ title: string; right?: React.ReactNode; className?: string }>
  = ({ title, right, className, children }) => (
  <div className={`mb-6 ${className || ''}`}>
    <div className="flex items-center justify-between mb-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      {right}
    </div>
    <div className="rounded-2xl border p-4 bg-white/60 shadow-sm">{children}</div>
  </div>
);

const coerceSequenced = (v:any, adapterId:string, defaults: SequencedPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const input = cleanItem(v.input) || null;
  const transitional = cleanItem(v.transitional) || defaults.transitional;
  const loops = typeof v.loops === 'number' ? Math.max(1, v.loops|0) : defaults.loops;

  const steps: SeqStep[] = Array.isArray(v.steps) ? v.steps.map((s:any) => {
    const kind: SeqStepKind = s?.kind;
    if (kind === 'pressing')   return { kind, processingTime: typeof s.processingTime==='number'?Math.max(1,s.processingTime):undefined, autoTransitionalResult: !!s.autoTransitionalResult };
    if (kind === 'cutting')    return { kind, processingTime: typeof s.processingTime==='number'?Math.max(1,s.processingTime):undefined, autoTransitionalResult: !!s.autoTransitionalResult };
    if (kind === 'deploying')  return { kind, addition: cleanItem(s.addition), keepHeldItem: !!s.keepHeldItem, autoTransitionalResult: s.autoTransitionalResult!==false };
    if (kind === 'spouting')   return { kind, fluid: cleanFluid(s.fluid), autoTransitionalResult: s.autoTransitionalResult!==false };
    if (kind === 'emptying')   return { kind, autoTransitionalResult: s.autoTransitionalResult!==false };
    if (kind === 'custom') {
      return {
        kind,
        type: (typeof s.type==='string' && s.type.trim()) ? s.type : 'create:deploying',
        includeTransitional: s.includeTransitional !== false,
        ingredients: Array.isArray(s.ingredients) ? s.ingredients.map((x:any)=>cleanItem(x)||null) : [],
        fluids: Array.isArray(s.fluids) ? s.fluids.map((x:any)=>cleanFluid(x)) : [],
        results: Array.isArray(s.results) ? s.results.map((x:any)=>cleanItem(x)).filter(Boolean) as ItemLike[] : undefined,
        processingTime: typeof s.processingTime==='number' ? Math.max(1, s.processingTime) : undefined,
        autoTransitionalResult: s.autoTransitionalResult !== false
      } as SeqCustomStep;
    }
    // Fallback auf pressing
    return { kind: 'pressing', autoTransitionalResult: true } as SeqPressingStep;
  }) : defaults.steps;

  const results = Array.isArray(v.results) ? v.results.map((o:any)=> cleanItem(o) ? { ...o } : null).filter(Boolean) as OutputLike[] : defaults.results;
  return { __type: adapterId, input, transitional, loops, steps, results, recipeId: v.recipeId } as any;
};

const SequencedEditor: RecipeAdapter<SequencedPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceSequenced(value as any, "create.sequenced", sequencedAdapter.defaults);

  const setTop = (patch: Partial<SequencedPayload>) => onChange({ ...safe, ...patch });

  const addStep = (kind: SeqStepKind) => {
    const next: SeqStep =
      kind === 'pressing'  ? { kind, autoTransitionalResult: true } :
      kind === 'cutting'   ? { kind, autoTransitionalResult: true } :
      kind === 'deploying' ? { kind, addition: null, keepHeldItem: false, autoTransitionalResult: true } :
      kind === 'spouting'  ? { kind, fluid: { id: "minecraft:water", amount: 250 }, autoTransitionalResult: true } :
      kind === 'emptying'  ? { kind, autoTransitionalResult: true } :
      { kind: 'custom', type: 'create:deploying', includeTransitional: true, ingredients: [], fluids: [], autoTransitionalResult: true };
    setTop({ steps: [...safe.steps, next] });
  };

  const updateStep = (idx:number, patch: Partial<SeqStep>) => {
    const steps = safe.steps.slice();
    steps[idx] = { ...steps[idx], ...patch } as any;
    setTop({ steps });
  };

  const removeStep = (idx:number) => setTop({ steps: safe.steps.filter((_,i)=>i!==idx) });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* LEFT: Top-Level Config */}
      <div>
        <Label>Start-Ingredient</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-64">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
            const id=prompt("Item/Tag", safe.input?.id||"minecraft:"); if(!id) return;
            const nbt=prompt("NBT as JSON (optional)", safe.input?.nbt||"");
            setTop({ input: cleanItem({ id, count: 1, nbt }) });
          }}>{safe.input ? safe.input.id : <span className="opacity-40">Empty</span>}</button>
          <Button variant="ghost" onClick={()=>setTop({ input: null })}><Trash2 size={16}/>Clear</Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <Label>Transitional Item</Label>
            <Input placeholder="create:incomplete_..." value={safe.transitional?.id||''}
              onChange={e=>setTop({ transitional: cleanItem({ ...(safe.transitional||{}), id:e.target.value, count:1 })! })}/>
          </div>
          <div>
            <Label>Loops</Label>
            <Input type="number" min={1} placeholder="1" value={safe.loops ?? 1}
              onChange={e=>setTop({ loops: Math.max(1, parseInt(e.target.value||'1',10)||1) })}/>
          </div>
        </div>

        <div className="mt-4">
          <Label>Steps hinzufügen</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['pressing','cutting','deploying','spouting','emptying','custom'] as SeqStepKind[]).map(k => (
              <Pill key={k} onClick={()=>addStep(k)}>{k}</Pill>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT: Final Results */}
      <div>
        <Label>Finale Results</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.results.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:final_item" value={o.id} onChange={e=>{
                const arr=safe.results.slice(); arr[i]={...o,id:e.target.value}; setTop({ results: arr });
              }}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>{
                const arr=safe.results.slice(); arr[i]={...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)}; setTop({ results: arr });
              }}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance??''} onChange={e=>{
                const val = e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)));
                const arr=safe.results.slice(); arr[i]={...o,chance:val}; setTop({ results: arr });
              }}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>{
                const arr=safe.results.slice(); arr.splice(i,1); setTop({ results: arr });
              }}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setTop({ results:[...safe.results, { id:"minecraft:iron_ingot", count:1 }] })}><Plus size={16}/>Result hinzufügen</Button>
        </div>
      </div>

      {/* Full Steps List */}
      <div className="md:col-span-2">
        <Label>Sequenz</Label>
        <div className="mt-2 flex flex-col gap-3">
          {safe.steps.map((s,idx)=>(
            <div key={idx} className="rounded-xl border p-3 bg-white/70">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Step #{idx+1}: <code>{s.kind}</code></div>
                <Button variant="ghost" onClick={()=>removeStep(idx)}><Trash2 size={16}/>Entfernen</Button>
              </div>

              {/* STEP FORMS */}
              {s.kind==='pressing' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <Label>Processing Time (Ticks, optional)</Label>
                    <Input type="number" min={1} placeholder="e.g. 100" value={s.processingTime ?? ''} onChange={e=>updateStep(idx,{ processingTime: e.target.value===''?undefined:Math.max(1,parseInt(e.target.value,10)||0) })}/>
                  </div>
                  <div className="flex items-end">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                      auto Transitional Result
                    </label>
                  </div>
                </div>
              )}

              {s.kind==='cutting' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <Label>Processing Time (Ticks, optional)</Label>
                    <Input type="number" min={1} placeholder="e.g. 100" value={s.processingTime ?? ''} onChange={e=>updateStep(idx,{ processingTime: e.target.value===''?undefined:Math.max(1,parseInt(e.target.value,10)||0) })}/>
                  </div>
                  <div className="flex items-end">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                      auto Transitional Result
                    </label>
                  </div>
                </div>
              )}

              {s.kind==='deploying' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <Label>Addition (oben)</Label>
                    <div className="mt-2 grid grid-cols-3 gap-2 w-64">
                      <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
                        const id=prompt("Item/Tag", s.addition?.id||"minecraft:"); if(!id) return;
                        const nbt=prompt("NBT as JSON (optional)", s.addition?.nbt||"");
                        updateStep(idx,{ addition: cleanItem({ id, count: 1, nbt }) as any });
                      }}>{s.addition ? s.addition.id : <span className="opacity-40">Empty</span>}</button>
                      <Button variant="ghost" onClick={()=>updateStep(idx,{ addition: null })}><Trash2 size={16}/>Clear</Button>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <label className="inline-flex items-center gap-2 text-sm mt-6">
                      <input type="checkbox" className="accent-indigo-600" checked={!!s.keepHeldItem} onChange={e=>updateStep(idx,{ keepHeldItem: e.target.checked })}/>
                      Keep Hand (Item nicht verbrauchen)
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                      auto Transitional Result
                    </label>
                  </div>
                </div>
              )}

              {s.kind==='spouting' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label>Fluid</Label>
                      <Input placeholder="minecraft:water" value={s.fluid?.id||''} onChange={e=>updateStep(idx,{ fluid: cleanFluid({ ...(s.fluid||{}), id:e.target.value, amount:s.fluid?.amount??250 }) as any })}/>
                    </div>
                    <div>
                      <Label>Amount (mb)</Label>
                      <Input type="number" min={1} placeholder="250" value={s.fluid?.amount??''} onChange={e=>updateStep(idx,{ fluid: cleanFluid({ ...(s.fluid||{}), id:s.fluid?.id||'minecraft:water', amount: Math.max(1, parseInt(e.target.value||'1',10)||1) }) as any })}/>
                    </div>
                  </div>
                  <div className="flex items-end">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                      auto Transitional Result
                    </label>
                  </div>
                </div>
              )}

              {s.kind==='emptying' && (
                <div className="mt-3">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                    auto Transitional Result
                  </label>
                </div>
              )}

              {s.kind==='custom' && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>Type</Label>
                    <Input placeholder="create:deploying / modid:step_type" value={s.type} onChange={e=>updateStep(idx,{ type: e.target.value })}/>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.includeTransitional!==false} onChange={e=>updateStep(idx,{ includeTransitional: e.target.checked })}/>
                      Transitional als erstes Ingredient
                    </label>
                    <div>
                      <Label>Ingredients</Label>
                      <div className="mt-2 flex flex-col gap-2">
                        {(s.ingredients||[]).map((ing,ii)=>(
                          <div key={ii} className="grid grid-cols-5 gap-2 items-center">
                            <Input className="col-span-3" placeholder="minecraft:iron_ingot / minecraft:gold_ingot" value={ing?.id||''} onChange={e=>{
                              const arr=(s.ingredients||[]).slice(); arr[ii]=cleanItem({ ...(ing||{}), id:e.target.value, count:1 }); updateStep(idx,{ ingredients: arr });
                            }}/>
                            <Button variant="ghost" onClick={()=>{
                              const arr=(s.ingredients||[]).slice(); arr.splice(ii,1); updateStep(idx,{ ingredients: arr });
                            }}><Trash2 size={16}/></Button>
                            <Button variant="outline" onClick={()=>{
                              const nbt = prompt("NBT as JSON (optional)", ing?.nbt || "");
                              const arr=(s.ingredients||[]).slice(); arr[ii]=cleanItem({ ...(ing||{}), nbt: nbt||undefined, count:1 }); updateStep(idx,{ ingredients: arr });
                            }}>NBT</Button>
                          </div>
                        ))}
                        <Button variant="outline" onClick={()=>updateStep(idx,{ ingredients:[...(s.ingredients||[]), { id:"minecraft:stone", count:1 } as any] })}><Plus size={16}/>Ingredient hinzufügen</Button>
                      </div>
                    </div>
                    <div>
                      <Label>Fluids</Label>
                      <div className="mt-2 flex flex-col gap-2">
                        {(s.fluids||[]).map((fl,fi)=>(
                          <div key={fi} className="grid grid-cols-5 gap-2 items-center">
                            <Input className="col-span-2" placeholder="minecraft:water" value={fl?.id||''} onChange={e=>{
                              const arr=(s.fluids||[]).slice(); arr[fi]=cleanFluid({ ...(fl||{}), id:e.target.value, amount: fl?.amount ?? 1000 }); updateStep(idx,{ fluids: arr });
                            }}/>
                            <Input type="number" min={1} className="col-span-2" placeholder="mb" value={fl?.amount??''} onChange={e=>{
                              const arr=(s.fluids||[]).slice(); arr[fi]=cleanFluid({ ...(fl||{}), id: fl?.id||"minecraft:water", amount: Math.max(1, parseInt(e.target.value||'1',10)||1) }); updateStep(idx,{ fluids: arr });
                            }}/>
                            <Button variant="ghost" onClick={()=>{
                              const arr=(s.fluids||[]).slice(); arr.splice(fi,1); updateStep(idx,{ fluids: arr });
                            }}><Trash2 size={16}/></Button>
                          </div>
                        ))}
                        <Button variant="outline" onClick={()=>updateStep(idx,{ fluids:[...(s.fluids||[]), { id:"minecraft:water", amount:1000 } as any] })}><Plus size={16}/>Fluid hinzufügen</Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label>Optionen</Label>
                    <Input type="number" min={1} placeholder="processingTime (Ticks, optional)" value={(s as SeqCustomStep).processingTime ?? ''} onChange={e=>updateStep(idx,{ processingTime: e.target.value===''?undefined:Math.max(1, parseInt(e.target.value,10)||0) })}/>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-indigo-600" checked={s.autoTransitionalResult!==false} onChange={e=>updateStep(idx,{ autoTransitionalResult: e.target.checked })}/>
                      auto Transitional Result
                    </label>
                    {/* Custom Results nur, wenn autoTransitionalResult ausgeschaltet */}
                    {(s.autoTransitionalResult===false) && (
                      <div className="mt-2">
                        <Label>Custom Results (optional)</Label>
                        <div className="mt-2 flex flex-col gap-2">
                          {((s as SeqCustomStep).results||[]).map((rr,ri)=>(
                            <div key={ri} className="grid grid-cols-5 gap-2 items-center">
                              <Input className="col-span-3" placeholder="minecraft:…" value={rr?.id||''} onChange={e=>{
                                const arr=([...(s as SeqCustomStep).results||[]]); arr[ri]=cleanItem({ ...(rr||{}), id:e.target.value, count: rr?.count ?? 1 })!; updateStep(idx,{ results: arr as any });
                              }}/>
                              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={rr?.count??1} onChange={e=>{
                                const arr=([...(s as SeqCustomStep).results||[]]); arr[ri]=cleanItem({ ...(rr||{}), count: Math.max(1, parseInt(e.target.value||'1',10)||1) })!; updateStep(idx,{ results: arr as any });
                              }}/>
                              <Button variant="ghost" onClick={()=>{
                                const arr=([...(s as SeqCustomStep).results||[]]); arr.splice(ri,1); updateStep(idx,{ results: arr as any });
                              }}><Trash2 size={16}/></Button>
                            </div>
                          ))}
                          <Button variant="outline" onClick={()=>{
                            const arr=([...(s as SeqCustomStep).results||[], { id:"minecraft:iron_ingot", count:1 }]); updateStep(idx,{ results: arr as any });
                          }}><Plus size={16}/>Result hinzufügen</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const sequencedAdapter: RecipeAdapter<SequencedPayload> = {
  id: "create.sequenced",
  title: "Create: Sequenced Assembly",
  icon: <Cog size={16} />,
  defaults: {
    input: null,
    transitional: { id: "create:incomplete_component", count: 1 },
    loops: 1,
    steps: [{ kind: 'pressing', autoTransitionalResult: true }],
    results: [{ id: "minecraft:iron_ingot", count: 1, chance: 1.0 }],
    recipeId: "example:create_sequenced"
  },
  Editor: SequencedEditor,
  validate: (p) => {
    const msgs: { level:"error"|"warn"; msg:string }[] = [];
    if (!p.input) msgs.push({ level:'error', msg:'Start-Ingredient fehlt.' });
    if (!p.transitional?.id) msgs.push({ level:'error', msg:'Transitional Item fehlt.' });
    if (!Array.isArray(p.steps) || p.steps.length===0) msgs.push({ level:'error', msg:'Mindestens ein Step erforderlich.' });
    if (!Array.isArray(p.results) || p.results.length===0) msgs.push({ level:'error', msg:'Mindestens ein finales Result erforderlich.' });
    return msgs;
  },
  
  toKubeJS: (p) => {
    const seq = p.steps.map(step => {
      const baseIngredients: any[] = [ transitionalIngredient(p.transitional) ];
      let obj: any;

      if (step.kind === 'pressing') {
        obj = { type: "create:pressing", ingredients: baseIngredients };
        if (step.processingTime) obj.processingTime = step.processingTime;
        obj.results = [ transitionalResult(p.transitional) ]; // <-- id form
      }

      if (step.kind === 'cutting') {
        obj = { type: "create:cutting", ingredients: baseIngredients };
        if (step.processingTime) obj.processingTime = step.processingTime;
        obj.results = [ transitionalResult(p.transitional) ];
      }

      if (step.kind === 'deploying') {
        const extra = step.addition ? [ itemToJson({ ...step.addition, count: 1 }) ] : [];
        obj = { type: "create:deploying", ingredients: [...baseIngredients, ...extra] };
        if (step.keepHeldItem) obj.keepHeldItem = true;
        obj.results = [ transitionalResult(p.transitional) ];
      }

      if (step.kind === 'spouting') {
        const fl = step.fluid ? [ fluidToJson(step.fluid) ] : [];
        obj = { type: "create:spouting", ingredients: [...baseIngredients, ...fl] };
        obj.results = [ transitionalResult(p.transitional) ];
      }

      if (step.kind === 'emptying') {
        obj = { type: "create:emptying", ingredients: baseIngredients };
        obj.results = [ transitionalResult(p.transitional) ];
      }

      if (step.kind === 'custom') {
        const c = step as SeqCustomStep;
        const items = expandItemsToJson(c.ingredients || []);
        const fluids = (c.fluids || []).filter(Boolean).map(fluidToJson);
        obj = {
          type: c.type,
          ingredients: [...(c.includeTransitional !== false ? baseIngredients : []), ...items, ...fluids]
        };
        if (c.processingTime) obj.processingTime = c.processingTime;
        obj.results = (c.autoTransitionalResult === false && c.results?.length)
          ? c.results.map(asResultId)             // <-- id form
          : [ transitionalResult(p.transitional) ];
      }

      return obj;
    });

    // top-level results must be in { id, ... } form too
    const topResults = p.results.map(asResultId);

    const obj: any = {
      type: "create:sequenced_assembly",
      ingredient: itemToJson({ ...(p.input as ItemLike), count: 1 }),
      transitional_item: { id: p.transitional.id },    // <-- snake_case + id form
      sequence: seq,
      results: topResults
    };
    if (typeof p.loops === 'number') obj.loops = Math.max(1, p.loops);
    else obj.loops = 1;


    return [`event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId?.trim() ? `.id('${p.recipeId}')` : ''};`];
  }

};


// ---------- Adapters: Vanilla (Shaped/Shapeless) ----------

type ShapedPayload = { result: ItemLike; grid: (ItemLike | null)[][]; recipeId?: string };
const letters = "ABCDEFGHI".split("");
function deriveShapedPattern(grid: (ItemLike | null)[][]) {
  const rows = grid.length; const cols = grid[0]?.length ?? 0;
  let top = 0, bottom = rows - 1, left = 0, right = cols - 1;
  const isRowEmpty = (r: number) => grid[r].every(c => !c);
  const isColEmpty = (c: number) => grid.every(r => !r[c]);
  while (top <= bottom && isRowEmpty(top)) top++;
  while (bottom >= top && isRowEmpty(bottom)) bottom--;
  while (left <= right && isColEmpty(left)) left++;
  while (right >= left && isColEmpty(right)) right--;
  if (top > bottom || left > right) return { pattern: [" ", " ", " "], key: {} as Record<string,string> };
  const mapping = new Map<string,string>(); let letterIdx = 0; const pattern: string[] = [];
  for (let r = top; r <= bottom; r++) {
    let line = "";
    for (let c = left; c <= right; c++) {
      const cell = grid[r][c];
      if (!cell) { line += " "; continue; }
      const sig = `${cell.id}|${cell.nbt ?? ''}`;
      if (!mapping.has(sig)) mapping.set(sig, letters[letterIdx++] ?? letters[letters.length - 1]);
      line += mapping.get(sig);
    }
    pattern.push(line);
  }
  const key: Record<string,string> = {};
  const sigToItem = (sig: string): ItemLike => { const [id, nbt] = sig.split("|"); return { id, count: 1, nbt: nbt || undefined }; };
  mapping.forEach((letter, sig) => { key[letter] = itemToKube(sigToItem(sig)); });
  return { pattern, key };
}

function deriveShapedPatternJson(grid: (ItemLike | null)[][]) {
  const rows = grid.length; const cols = grid[0]?.length ?? 0;
  let top = 0, bottom = rows - 1, left = 0, right = cols - 1;
  const isRowEmpty = (r: number) => grid[r].every(c => !c);
  const isColEmpty = (c: number) => grid.every(r => !r[c]);
  while (top <= bottom && isRowEmpty(top)) top++;
  while (bottom >= top && isRowEmpty(bottom)) bottom--;
  while (left <= right && isColEmpty(left)) left++;
  while (right >= left && isColEmpty(right)) right--;
  if (top > bottom || left > right) return { pattern: [" ", " ", " "], key: {} as Record<string, any> };

  const mapping = new Map<string,string>(); let letterIdx = 0; const pattern: string[] = [];
  const sigFor = (cell: ItemLike) => `${cell.id}|${cell.nbt ?? ''}`;
  const sigToItem = (sig: string): ItemLike => {
    const [id, nbt] = sig.split("|");
    return { id, count: 1, nbt: nbt || undefined };
  };

  for (let r = top; r <= bottom; r++) {
    let line = "";
    for (let c = left; c <= right; c++) {
      const cell = grid[r][c];
      if (!cell) { line += " "; continue; }
      const sig = sigFor(cell);
      if (!mapping.has(sig)) mapping.set(sig, letters[letterIdx++] ?? letters[letters.length - 1]);
      line += mapping.get(sig);
    }
    pattern.push(line);
  }

  const key: Record<string, any> = {};
  mapping.forEach((letter, sig) => { key[letter] = itemToJson(sigToItem(sig)); });
  return { pattern, key };
}

const coerceShaped = (v: any, adapterId: string, defaults: ShapedPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const grid = Array.isArray(v.grid) && v.grid.length === 3 && v.grid.every((r: any) => Array.isArray(r) && r.length === 3)
    ? v.grid : Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null));
  const result = cleanItem(v.result) || defaults.result;
  return { __type: adapterId, result, grid, recipeId: v.recipeId } as any;
};

const ShapedEditor: RecipeAdapter<ShapedPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceShaped(value as any, "vanilla.shaped", shapedAdapter.defaults);
  const setCell = (r: number, c: number, item: ItemLike | null) => {
    const grid = safe.grid.map(row => row.slice()); grid[r][c] = item; onChange({ ...safe, grid });
  };
  const pick = (r: number, c: number) => {
    const id = prompt("Item-ID oder Tag (e.g. minecraft:stick oder minecraft:gold_ingot)", safe.grid[r][c]?.id || "minecraft:");
    if (!id) return; 
    const nbt = prompt("NBT as JSON (optional)", safe.grid[r][c]?.nbt || "");
    setCell(r, c, cleanItem({ id, count: 1, nbt }));
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>3×3 Grid</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          {safe.grid.map((row, r) => row.map((cell, c) => (
            <button key={`${r}-${c}`} onClick={() => pick(r, c)} className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs">
              {cell ? cell.id : <span className="opacity-40">Empty</span>}
            </button>
          )))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="ghost" onClick={() => onChange(tagPayload("vanilla.shaped", { ...safe, grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null)) }) as any)}><Trash2 size={16}/>Clear</Button>
        </div>
      </div>
      <div>
        <Label>Result</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input placeholder="minecraft:stick" value={safe.result?.id || ''} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, id: e.target.value }) || { id: '', count: 1 } })} />
          <Input type="number" min={1} placeholder="Menge" value={safe.result?.count ?? 1} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, count: parseInt(e.target.value || '1', 10) }) || { id: '', count: 1 } })} />
          <div className="col-span-2">
            <Input placeholder='NBT as JSON (optional), e.g. {"Damage":0}' value={safe.result?.nbt || ''} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, nbt: e.target.value }) || { id: '', count: 1 } })} />
          </div>
        </div>
        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={() => onChange({ ...safe, result: cleanItem({ ...safe.result, id })! })}>{id}</Pill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const shapedAdapter: RecipeAdapter<ShapedPayload> = {
  id: "vanilla.shaped",
  title: "Vanilla: Shaped Crafting",
  icon: <Hammer size={16} />,
  defaults: { result: { id: "minecraft:stick", count: 2 }, grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null)),  },
  Editor: ShapedEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    const hasAny = Array.isArray(p.grid) && p.grid.some(row => Array.isArray(row) && row.some(Boolean));
    if (!hasAny) msgs.push({ level: 'error', msg: 'Grid ist Empty.' });
    if (!p.result?.id) msgs.push({ level: 'error', msg: 'Result Item missing!' });
    return msgs;
  },
  toKubeJS: (p) => {
    const { pattern, key } = deriveShapedPattern(p.grid);

    const result = itemToKube(p.result); // e.g. '2x minecraft:stick' oder Item.of(...)

    // Pattern als Array von Strings
    const patternJs = `[${pattern.map(s => `'${s}'`).join(', ')}]`;

    // Mapping-Objekt
    const keyJs = `{ ${Object.entries(key).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;

    const call = `event.shaped(${result}, ${patternJs}, ${keyJs})`;
    return [p.recipeId?.trim() ? `${call}.id('${p.recipeId}');` : `${call};`];
  }


};

type ShapelessPayload = { result: ItemLike; inputs: (ItemLike | null)[]; recipeId?: string };
const coerceShapeless = (v: any, adapterId: string, defaults: ShapelessPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const inputs = Array.isArray(v.inputs) ? v.inputs.slice(0, 9) : Array.from({ length: 9 }, () => null);
  while (inputs.length < 9) inputs.push(null);
  const result = cleanItem(v.result) || defaults.result;
  return { __type: adapterId, result, inputs, recipeId: v.recipeId } as any;
};

const ShapelessEditor: RecipeAdapter<ShapelessPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceShapeless(value as any, "vanilla.shapeless", shapelessAdapter.defaults);
  const setInput = (idx: number, item: ItemLike | null) => { const inputs = safe.inputs.slice(); inputs[idx] = item; onChange({ ...safe, inputs }); };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Inputs (max. 9)</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          {safe.inputs.map((cell, i) => (
            <button key={i} onClick={() => {
              const id = prompt("Item-ID/Tag", cell?.id || "minecraft:"); if (!id) return;
              const nbt = prompt("NBT as JSON (optional)", cell?.nbt || "");
              setInput(i, cleanItem({ id, count: 1, nbt }));
            }} className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs">
              {cell ? cell.id : <span className="opacity-40">Empty</span>}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>Result</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input placeholder="minecraft:bread" value={safe.result?.id || ''} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, id: e.target.value }) || { id: '', count: 1 } })} />
          <Input type="number" min={1} placeholder="Menge" value={safe.result?.count ?? 1} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, count: parseInt(e.target.value || '1', 10) }) || { id: '', count: 1 } })} />
          <div className="col-span-2">
            <Input placeholder='NBT as JSON (optional)' value={safe.result?.nbt || ''} onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, nbt: e.target.value }) || { id: '', count: 1 } })} />
          </div>
        </div>
        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={() => onChange({ ...safe, result: cleanItem({ ...safe.result, id })! })}>{id}</Pill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const shapelessAdapter: RecipeAdapter<ShapelessPayload> = {
  id: "vanilla.shapeless",
  title: "Vanilla: Shapeless Crafting",
  icon: <Wrench size={16} />,
  defaults: { result: { id: "minecraft:bread", count: 1 }, inputs: Array.from({ length: 9 }, () => null), recipeId: "example:bread_custom" },
  Editor: ShapelessEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    const hasAny = Array.isArray(p.inputs) && p.inputs.some(Boolean);
    if (!hasAny) msgs.push({ level: 'error', msg: 'Mindestens ein Input wird benötigt.' });
    if (!p.result?.id) msgs.push({ level: 'error', msg: 'Result Item missing!' });
    return msgs;
  },
  toKubeJS: (p) => {
    const inputs = p.inputs
      .filter(Boolean)
      .map(i => itemToKube({ ...(i as ItemLike), count: 1 })) // count erzwingen
      .join(', ');
    const result = itemToKube(p.result);

    const call = `event.shapeless(${result}, [${inputs}])`;
    return [p.recipeId?.trim() ? `${call}.id('${p.recipeId}');` : `${call};`];
  }
};

// ---------- Adapter: Vanilla (Smelting / Furnace) ----------

type SmeltingPayload = {
  input: ItemLike | null;     // always 1x (no count asked)
  result: ItemLike;           // may have count/NBT
  xp?: number;                // optional experience
  cookingTime?: number;       // optional ticks (default 200)
  recipeId?: string;
};

const coerceSmelting = (v: any, adapterId: string, defaults: SmeltingPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const input = cleanItem(v.input) || null;
  const result = cleanItem(v.result) || defaults.result;
  const xp = typeof v.xp === 'number' ? v.xp : undefined;
  const cookingTime = typeof v.cookingTime === 'number' ? Math.max(1, v.cookingTime) : undefined;
  return { __type: adapterId, input, result, xp, cookingTime, recipeId: v.recipeId } as any;
};

const SmeltingEditor: RecipeAdapter<SmeltingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceSmelting(value as any, "vanilla.smelting", smeltingAdapter.defaults);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button
            className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs"
            onClick={() => {
              const id = prompt("Input Item/Tag", safe.input?.id || "minecraft:");
              if (!id) return;
              const nbt = prompt("NBT as JSON (optional)", safe.input?.nbt || "");
              onChange({ ...safe, input: cleanItem({ id, count: 1, nbt }) });
            }}
          >
            {safe.input ? safe.input.id : <span className="opacity-40">Empty</span>}
          </button>
          <Button variant="ghost" onClick={() => onChange({ ...safe, input: null })}><Trash2 size={16}/>Clear</Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <Label>XP (optional)</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="e.g. 0.1"
              value={safe.xp ?? ''}
              onChange={e => onChange({ ...safe, xp: e.target.value === '' ? undefined : (parseFloat(e.target.value) || 0) })}
            />
          </div>
          <div>
            <Label>Cook time (Ticks, optional)</Label>
            <Input
              type="number"
              min={1}
              placeholder="e.g. 200"
              value={safe.cookingTime ?? ''}
              onChange={e => onChange({ ...safe, cookingTime: e.target.value === '' ? undefined : Math.max(1, parseInt(e.target.value, 10) || 0) })}
            />
          </div>
        </div>
      </div>

      <div>
        <Label>Result</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            placeholder="minecraft:glass"
            value={safe.result?.id || ''}
            onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, id: e.target.value }) || { id: '', count: 1 } })}
          />
          <Input
            type="number"
            min={1}
            placeholder="Menge"
            value={safe.result?.count ?? 1}
            onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) }) || { id: '', count: 1 } })}
          />
          <div className="col-span-2">
            <Input
              placeholder='NBT as JSON (optional)'
              value={safe.result?.nbt || ''}
              onChange={e => onChange({ ...safe, result: cleanItem({ ...safe.result, nbt: e.target.value }) || { id: '', count: 1 } })}
            />
          </div>
        </div>

        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={() => onChange({ ...safe, result: cleanItem({ ...safe.result, id })! })}>{id}</Pill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const smeltingAdapter: RecipeAdapter<SmeltingPayload> = {
  id: "vanilla.smelting",
  title: "Vanilla: Smelting (Furnace)",
  icon: <Flame size={16} />,
  defaults: {
    input: null,
    result: { id: "minecraft:glass", count: 1 },
    xp: 0.1,
    cookingTime: 200,
  },
  Editor: SmeltingEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!p.input) msgs.push({ level: 'error', msg: 'Input Item missing!' });
    if (!p.result?.id) msgs.push({ level: 'error', msg: 'Result Item missing!' });
    return msgs;
  },
  toKubeJS: (p) => {
    const result = itemToKube(p.result);
    // Input IMMER als 1x (Furnace nimmt nur eins)
    const input = itemToKube({ ...(p.input as ItemLike), count: 1 });

    let line = `event.smelting(${result}, ${input})`;
    if (typeof p.xp === 'number' && !Number.isNaN(p.xp)) line += `.xp(${p.xp})`;
    if (p.cookingTime && p.cookingTime > 0) line += `.cookingTime(${p.cookingTime})`;
    line += p.recipeId?.trim() ? `.id('${p.recipeId}')` : '';
    line += ';';
    return [line];
  }
};

// ---------- Adapter: Custom (event.custom) ----------

type CustomPayload = {
  type: string;                    // e.g. "create:mixing", "ae2:inscriber", "whatever:recipe"
  ingredients: (ItemLike | null)[]; // counts allowed here (module-agnostic)
  results: OutputLike[];           // count / chance supported
  extra?: string;                  // free-form JSON merged into top-level
  recipeId?: string;               // will be overwritten to shadoukube:<...> by addToProject
};

const coerceCustom = (v: any, adapterId: string, defaults: CustomPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const type = typeof v.type === 'string' ? v.type : defaults.type;
  const ingredients = Array.isArray(v.ingredients) ? v.ingredients.slice(0, 20).map((x:any)=> cleanItem(x) || null) : defaults.ingredients;
  const results = Array.isArray(v.results) ? v.results.slice(0, 20).map((o:any)=> cleanItem(o) ? { ...o } : null).filter(Boolean) as OutputLike[] : defaults.results;
  const extra = typeof v.extra === 'string' ? v.extra : undefined;
  return { __type: adapterId, type, ingredients, results, extra, recipeId: v.recipeId } as any;
};

const CustomEditor: RecipeAdapter<CustomPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceCustom(value as any, "custom.generic", customAdapter.defaults);

  const setIng = (idx: number, it: ItemLike | null) => {
    const arr = safe.ingredients.slice();
    if (it === null) arr.splice(idx, 1); else arr[idx] = it;
    onChange({ ...safe, ingredients: arr });
  };
  const addIng = () => onChange({ ...safe, ingredients: [...safe.ingredients, { id: "minecraft:stone", count: 1 }] });

  const setRes = (idx: number, out: OutputLike | null) => {
    const arr = safe.results.slice();
    if (out === null) arr.splice(idx, 1); else arr[idx] = out;
    onChange({ ...safe, results: arr });
  };
  const addRes = () => onChange({ ...safe, results: [...safe.results, { id: "minecraft:diamond", count: 1 }] });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Type</Label>
        <Input
          placeholder="z. B. create:mixing / ae2:inscriber / modid:recipe_type"
          value={safe.type}
          onChange={e => onChange({ ...safe, type: e.target.value })}
        />

        <div className="mt-4">
          <Label>Ingredients</Label>
          <div className="mt-2 flex flex-col gap-2">
            {safe.ingredients.map((ing, i) => (
              <div key={i} className="grid grid-cols-6 gap-2 items-center">
                <Input
                  className="col-span-3"
                  placeholder="minecraft:iron_ingot oder minecraft:gold_ingot"
                  value={ing?.id || ''}
                  onChange={e => setIng(i, cleanItem({ ...(ing || {}), id: e.target.value, count: 1 }) )}
                />
                <Input
                  type="number"
                  min={1}
                  className="col-span-1"
                  placeholder="Menge"
                  value={ing?.count ?? 1}
                  onChange={e => setIng(i, cleanItem({ ...(ing || {}), count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) }) )}
                />
                <Button
                  variant="ghost"
                  className="col-span-1"
                  onClick={() => setIng(i, null)}
                ><Trash2 size={16}/></Button>
                <Button
                  variant="outline"
                  className="col-span-1"
                  onClick={() => setIng(i, cleanItem({ id: ing?.id || 'minecraft:', count: 1, nbt: prompt('NBT as JSON (optional)', ing?.nbt || '') || undefined }))}
                >NBT</Button>
              </div>
            ))}
            <div>
              <Button variant="outline" onClick={addIng}><Plus size={16}/>Ingredient hinzufügen</Button>
            </div>
          </div>

          <div className="mt-4">
            <Label>Quicktags</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {itemPalette.map(id => (
                <Pill key={id} onClick={() => onChange({ ...safe, ingredients: [...safe.ingredients, { id, count: 1 }] })}>{id}</Pill>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <Label>Results</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.results.map((o, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_nugget" value={o.id} onChange={e => setRes(i, { ...o, id: e.target.value })} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count ?? 1} onChange={e => setRes(i, { ...o, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })} />
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance ?? ''} onChange={e => setRes(i, { ...o, chance: e.target.value === '' ? undefined : Math.max(0, Math.min(0.9999, parseFloat(e.target.value))) })} />
              <Button variant="ghost" className="col-span-1" onClick={() => setRes(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <div>
            <Button variant="outline" onClick={addRes}><Plus size={16}/>Result hinzufügen</Button>
          </div>
        </div>

        <div className="mt-4">
          <Label>Extra JSON (optional, top-level merge)</Label>
          <textarea
            placeholder='z. B. {"heat_requirement":"heated","processingTime":120}'
            value={safe.extra || ""}
            onChange={e => onChange({ ...safe, extra: e.target.value })}
            className="border rounded-xl px-3 py-2 w-full h-28 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
          <div className="mt-2 text-xs opacity-70">
            Wird in das Top-Level JSON gemerged. Felder <code>type</code>, <code>ingredients</code>, <code>results</code> aus diesem Editor haben Vorrang.
          </div>
        </div>
      </div>
    </div>
  );
};

const customAdapter: RecipeAdapter<CustomPayload> = {
  id: "custom.generic",
  title: "Custom: event.custom",
  icon: <Braces size={16} />, // oder <Cog size={16} />
  defaults: {
    type: "create:mixing",
    ingredients: [{ id: "minecraft:stick", count: 2 }],
    results: [{ id: "minecraft:diamond", count: 1 }],
    extra: "",
    recipeId: "example:custom_recipe"
  },
  Editor: CustomEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!p.type?.trim()) msgs.push({ level: 'error', msg: 'Type fehlt (z. B. create:mixing).' });
    if (!Array.isArray(p.results) || p.results.length === 0) msgs.push({ level: 'error', msg: 'Mindestens ein Result wird benötigt.' });
    return msgs;
  },
  toKubeJS: (p) => {
    // Build base object
    let obj: any = {
      type: p.type,
      ingredients: p.ingredients.filter(Boolean).map(i => itemToJson(i as ItemLike)), // counts erlaubt
      results: p.results.map(outputToJson)
    };

    // Merge extra JSON on top (user-defined)
    const extra = parseNbt(p.extra); // reuse parser (returns undefined on invalid)
    if (extra && typeof extra === 'object') {
      obj = { ...extra, ...obj }; // Editor fields take precedence
    }

    const line = `event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId?.trim() ? `.id('${p.recipeId}')` : ''};`;
    return [line];
  }
};


// ---------- Adapters: Create (Milling / Crushing / Mixing) ----------



// ---------- Create: Mechanical Crafting ----------
type MechanicalPayload = { pattern: string[]; key: Record<string, ItemLike | null>; result: ItemLike; acceptMirrored?: boolean; recipeId?: string };

const coerceMechanical=(v:any,id:string,d:MechanicalPayload)=>{
  if(!v||v.__type!==id) return tagPayload(id,d);
  const pattern = Array.isArray(v.pattern)?v.pattern.map((s:string)=>String(s)):(d.pattern);
  const keyObj: Record<string, ItemLike | null> = typeof v.key==='object'&&v.key?v.key:{};
  const result = cleanItem(v.result)||d.result;
  const acceptMirrored = typeof v.acceptMirrored==='boolean'?v.acceptMirrored:undefined;
  return { __type:id, pattern, key: keyObj, result, acceptMirrored, recipeId:v.recipeId } as any;
};

const MechanicalEditor: RecipeAdapter<MechanicalPayload>["Editor"] = ({ value, onChange }) => {
  const safe = coerceMechanical(value as any, "create.mechanical_crafting", mechanicalAdapter.defaults);

  const patternText = (safe.pattern||[]).join("\n");
  const updatePattern = (t:string) => {
    const lines = t.replace(/\r/g,'').split("\n").map(s=>s);
    // ensure keys exist for used letters
    const used = Array.from(new Set(lines.join('').split('').filter(ch => ch !== ' ' && ch !== '')));
    const k = { ...safe.key };
    for (const ch of used) if (!(ch in k)) k[ch] = null;
    onChange({ ...safe, pattern: lines, key: k });
  };

  const usedLetters = Array.from(new Set((safe.pattern||[]).join('').split('').filter(ch=>ch!==' ')));

  const setKey = (letter:string, it: ItemLike | null) => {
    const k = { ...safe.key };
    k[letter] = it;
    onChange({ ...safe, key: k });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Pattern</Label>
        <textarea
          className="border rounded-xl px-3 py-2 w-full h-28 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          placeholder={'ABC\nD E\nFGH'}
          value={patternText}
          onChange={e => updatePattern(e.target.value)}
        />
        <div className="mt-4">
          <Label>Mapping (Buchstabe → Ingredient)</Label>
          <div className="mt-2 flex flex-col gap-2">
            {usedLetters.length === 0 && <div className="text-xs opacity-60">No Pattern given.</div>}
            {usedLetters.map(letter => (
              <div key={letter} className="grid grid-cols-5 gap-2 items-center">
                <div className="text-sm font-mono col-span-1">{letter}:</div>
                <Input className="col-span-3" placeholder="minecraft:iron_ingot / minecraft:gold_ingot" value={safe.key[letter]?.id || ''} onChange={e => setKey(letter, cleanItem({ ...(safe.key[letter]||{}), id: e.target.value, count: 1 }))}/>
                <Button variant="ghost" onClick={() => setKey(letter, null)}><Trash2 size={16}/></Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div>
        <Label>Result</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input placeholder="minecraft:contraption" value={safe.result?.id||''} onChange={e=>onChange({...safe,result:cleanItem({ ...(safe.result||{}), id:e.target.value })||{id:'',count:1}})}/>
          <Input type="number" min={1} placeholder="Menge" value={safe.result?.count??1} onChange={e=>onChange({...safe,result:cleanItem({ ...(safe.result||{}), count:Math.max(1,parseInt(e.target.value||'1',10)||1) })||{id:'',count:1}})}/>
          <div className="col-span-2">
            <Input placeholder="NBT as JSON (optional)" value={safe.result?.nbt||''} onChange={e=>onChange({...safe,result:cleanItem({ ...(safe.result||{}), nbt:e.target.value })||{id:'',count:1}})}/>
          </div>
        </div>

        <div className="mt-4">
          <Label>Optionen</Label>
          <div className="mt-2 flex gap-2 items-center">
            <Pill active={!!safe.acceptMirrored} onClick={()=>onChange({...safe,acceptMirrored:!safe.acceptMirrored})}>{safe.acceptMirrored?'acceptMirrored: true':'acceptMirrored: false'}</Pill>
          </div>
        </div>
      </div>
    </div>
  );
};

const mechanicalAdapter: RecipeAdapter<MechanicalPayload> = {
  id: "create.mechanical_crafting",
  title: "Create: Mechanical Crafting",
  icon: <Cog size={16} />,
  defaults: { pattern: [""], key: { A: { id: "minecraft:iron_ingot", count: 1 } }, result: { id: "minecraft:iron_block", count: 1 }, acceptMirrored: false, recipeId: "example:create_mechanical" },
  Editor: MechanicalEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!Array.isArray(p.pattern) || p.pattern.length === 0) msgs.push({level:'error',msg:'Pattern fehlt.'});
    const used = Array.from(new Set((p.pattern||[]).join('').split('').filter(ch=>ch!==' ')));
    for (const ch of used) if (!p.key?.[ch]?.id) msgs.push({level:'error',msg:`Mapping für '${ch}' fehlt.`});
    if (!p.result?.id) msgs.push({level:'error',msg:'Result Item missing!'});
    return msgs;
  },
  toKubeJS: (p) => {
    const keyJson: Record<string, any> = {};
    Object.entries(p.key||{}).forEach(([k,v]) => { if (v) keyJson[k] = itemToJson({ ...v, count: 1 }); });
    const obj:any = {
      type: "create:mechanical_crafting",
      pattern: p.pattern,
      key: keyJson,
      result: resultObjForCreate(p.result)
    };
    if (typeof p.acceptMirrored === 'boolean') obj.acceptMirrored = p.acceptMirrored;
    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};


// ---------- Create: Compacting ----------
type CompactingPayload = { items: (ItemLike | null)[]; fluids: (FluidLike | null)[]; outputs: OutputLike[]; heat?: Heating; recipeId?: string };

const coerceCompacting=(v:any,id:string,d:CompactingPayload)=>{
  if(!v||v.__type!==id) return tagPayload(id,d);
  const items = Array.isArray(v.items)?v.items.slice(0,9).map((x:any)=>cleanItem(x)||null):d.items;
  const fluids = Array.isArray(v.fluids)?v.fluids.slice(0,4).map((x:any)=>cleanFluid(x)):d.fluids;
  const outputs = Array.isArray(v.outputs)?v.outputs.filter(Boolean):d.outputs;
  const heat: Heating = v.heat==='heated'||v.heat==='superheated'?'heated'===v.heat?'heated':'superheated':'none';
  return { __type:id, items, fluids, outputs, heat, recipeId:v.recipeId } as any;
};

const CompactingEditor: RecipeAdapter<CompactingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceCompacting(value as any, "create.compacting", compactingAdapter.defaults);
  const setItem=(i:number,it:ItemLike|null)=>{const arr=safe.items.slice(); if(it===null) arr.splice(i,1); else arr[i]=it; onChange({...safe,items:arr});};
  const addItem = ()=>onChange({...safe,items:[...safe.items, null]});
  const setFluid=(i:number,fl:FluidLike|null)=>{const arr=safe.fluids.slice(); if(fl===null) arr.splice(i,1); else arr[i]=fl; onChange({...safe,fluids:arr});};
  const addFluid= ()=>onChange({...safe,fluids:[...safe.fluids, { id:"minecraft:water", amount:1000 }]});
  const setOut=(i:number,out:OutputLike|null)=>{const arr=safe.outputs.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,outputs:arr});};

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Item Inputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.items.map((cell,i)=>(
            <div key={i} className="grid grid-cols-5 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_ingot" value={cell?.id||''} onChange={e=>setItem(i, cleanItem({ ...(cell||{}), id:e.target.value, count: Math.max(1, cell?.count ?? 1) }))}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={cell?.count??1} onChange={e=>setItem(i, cleanItem({ ...(cell||{}), count: Math.max(1, parseInt(e.target.value||'1',10)||1) }))}/>
              <Button variant="ghost" onClick={()=>setItem(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={addItem}><Plus size={16}/>Item hinzufügen</Button>
        </div>

        <div className="mt-4">
          <Label>Fluid Inputs</Label>
          <div className="mt-2 flex flex-col gap-2">
            {safe.fluids.map((f,i)=>(
              <div key={i} className="grid grid-cols-5 gap-2 items-center">
                <Input className="col-span-2" placeholder="minecraft:water" value={f?.id||''} onChange={e=>setFluid(i, cleanFluid({ ...(f||{}), id:e.target.value, amount: f?.amount ?? 1000 }))}/>
                <Input type="number" min={1} className="col-span-2" placeholder="mb" value={f?.amount??''} onChange={e=>setFluid(i, cleanFluid({ ...(f||{}), id:f?.id||'minecraft:water', amount: Math.max(1, parseInt(e.target.value||'1',10)||1) }))}/>
                <Button variant="ghost" onClick={()=>setFluid(i,null)}><Trash2 size={16}/></Button>
              </div>
            ))}
            <Button variant="outline" onClick={addFluid}><Plus size={16}/>Fluid hinzufügen</Button>
          </div>
        </div>

        <div className="mt-4">
          <Label>Hitze</Label>
          <div className="mt-2 flex gap-2">
            {(["none","heated","superheated"] as Heating[]).map(h => (
              <Pill key={h} active={(safe.heat||'none')===h} onClick={()=>onChange({...safe,heat:h})}>{h}</Pill>
            ))}
          </div>
        </div>
      </div>

      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_block" value={o.id} onChange={e=>setOut(i,{...o,id:e.target.value})}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOut(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance" value={o.chance??''} onChange={e=>setOut(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>setOut(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setOut(safe.outputs.length,{id:"minecraft:iron_block",count:1})}><Plus size={16}/>Output hinzufügen</Button>
        </div>

        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={()=>onChange({...safe, outputs:[...safe.outputs, { id, count: 1 }]})}>{id}</Pill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const compactingAdapter: RecipeAdapter<CompactingPayload> = {
  id: "create.compacting",
  title: "Create: Compacting",
  icon: <Cog size={16} />,
  defaults: { items: [], fluids: [], outputs: [{ id: "minecraft:iron_block", count: 1 }], heat: 'none', recipeId: "example:create_compacting" },
  Editor: CompactingEditor,
  validate: p => { const m=[] as any[]; if(!p.items?.length && !p.fluids?.length) m.push({level:'error',msg:'Mindestens ein Item/Fluid-Input.'}); if(!p.outputs?.length) m.push({level:'error',msg:'Mindestens ein Output.'}); return m; },
  toKubeJS: p => {
    const ingredients:any[] = [
      ...expandItemsToJson(p.items||[]),
      ...((p.fluids||[]).filter(Boolean) as FluidLike[]).map(fluidToJson)
    ];
    const obj:any = { type:"create:compacting", ingredients, results: p.outputs.map(outputToJson) };
    if (p.heat==='heated') obj.heat_requirement='heated';
    if (p.heat==='superheated') obj.heat_requirement='superheated';
    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};


// ---------- Create: Fan Processing (factory) ----------
type FanPayload = { input: ItemLike | null; outputs: OutputLike[]; recipeId?: string };

const makeFanAdapter = (rid: string, title: string): RecipeAdapter<FanPayload> => {
  const coerce = (v:any)=>!v||v.__type!==rid?tagPayload(rid,{input:null,outputs:[{id:"minecraft:clay",count:1}],recipeId:`example:${rid.replace('.','_')}`}):({__type:rid,input:cleanItem(v.input)||null,outputs:Array.isArray(v.outputs)?v.outputs.filter(Boolean):[{id:"minecraft:clay",count:1}],recipeId:v.recipeId} as any);
  const Editor: RecipeAdapter<FanPayload>["Editor"] = ({ value, onChange }) => {
    const safe = coerce(value as any);
    const setOut=(i:number,out:OutputLike|null)=>{const arr=safe.outputs.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,outputs:arr});};
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label>Input</Label>
          <div className="mt-2 grid grid-cols-3 gap-2 w-56">
            <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
              const id=prompt("Input", safe.input?.id||"minecraft:"); if(!id)return;
              const nbt=prompt("NBT as JSON (optional)", safe.input?.nbt||"");
              onChange({...safe,input:cleanItem({id, count:1, nbt})});
            }}>{safe.input?safe.input.id:<span className="opacity-40">Empty</span>}</button>
            <Button variant="ghost" onClick={()=>onChange({...safe,input:null})}><Trash2 size={16}/>Clear</Button>
          </div>
        </div>
        <div>
          <Label>Outputs</Label>
          <div className="mt-2 flex flex-col gap-2">
            {safe.outputs.map((o,i)=>(
              <div key={i} className="grid grid-cols-6 gap-2 items-center">
                <Input className="col-span-3" placeholder="minecraft:clay" value={o.id} onChange={e=>setOut(i,{...o,id:e.target.value})}/>
                <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOut(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
                <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance" value={o.chance??''} onChange={e=>setOut(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
                <Button variant="ghost" className="col-span-1" onClick={()=>setOut(i,null)}><Trash2 size={16}/></Button>
              </div>
            ))}
            <Button variant="outline" onClick={()=>setOut(safe.outputs.length,{id:"minecraft:clay",count:1})}><Plus size={16}/>Output hinzufügen</Button>
          </div>
        </div>
      </div>
    );
  };
  return {
    id: rid,
    title: title,
    icon: <Cog size={16} />,
    defaults: { input: null, outputs: [{ id: "minecraft:clay", count: 1 }], recipeId: `example:${rid.replace('.','_')}` },
    Editor,
    validate: p => { const m=[] as any[]; if(!p.input)m.push({level:'error',msg:'Input Item missing!'}); if(!p.outputs?.length)m.push({level:'error',msg:'Mindestens ein Output wird benötigt.'}); return m; },
    toKubeJS: p => {
      const obj:any = { type:`create:${rid.split('.')[1]}`, ingredients: p.input?[itemToJson({...(p.input as ItemLike),count:1})]:[], results: p.outputs.map(outputToJson) };
      return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
    }
  };
};

const splashingAdapter   = makeFanAdapter("create.splashing", "Create: Splashing");
const smokingAdapter     = makeFanAdapter("create.smoking", "Create: Smoking");
const blastingFanAdapter = makeFanAdapter("create.blasting", "Create: Blasting (Fan)");
const hauntingAdapter    = makeFanAdapter("create.haunting", "Create: Haunting");


// ---------- Create: Filling ----------
type FillingPayload = { item: ItemLike | null; fluid: FluidLike | null; results: OutputLike[]; recipeId?: string };

const coerceFilling=(v:any,id:string,d:FillingPayload)=>!v||v.__type!==id?tagPayload(id,d):({__type:id,item:cleanItem(v.item)||null,fluid:cleanFluid(v.fluid),results:Array.isArray(v.results)?v.results.filter(Boolean):d.results,recipeId:v.recipeId} as any);

const FillingEditor: RecipeAdapter<FillingPayload>["Editor"] = ({ value, onChange }) => {
  const safe = coerceFilling(value as any, "create.filling", fillingAdapter.defaults);
  const setOutput=(i:number,out:OutputLike|null)=>{const arr=safe.results.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,results:arr});};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Item + Fluid</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-64">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
            const id=prompt("Item", safe.item?.id||"minecraft:"); if(!id)return;
            const nbt=prompt("NBT as JSON (optional)", safe.item?.nbt||"");
            onChange({...safe,item:cleanItem({id, count:1, nbt})});
          }}>{safe.item?safe.item.id:<span className="opacity-40">item Empty</span>}</button>
          <div className="col-span-2 grid grid-cols-2 gap-2">
            <Input placeholder="fluid id" value={safe.fluid?.id||''} onChange={e=>onChange({...safe,fluid:cleanFluid({ ...(safe.fluid||{}), id:e.target.value, amount:safe.fluid?.amount??1000 })})}/>
            <Input type="number" min={1} placeholder="mb" value={safe.fluid?.amount??''} onChange={e=>onChange({...safe,fluid:cleanFluid({ ...(safe.fluid||{}), id:safe.fluid?.id||'minecraft:water', amount:Math.max(1,parseInt(e.target.value||'1',10)||1) })})}/>
          </div>
        </div>
      </div>
      <div>
        <Label>Results</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.results.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:potion" value={o.id} onChange={e=>setOutput(i,{...o,id:e.target.value})}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOutput(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance" value={o.chance??''} onChange={e=>setOutput(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>setOutput(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setOutput(safe.results.length,{id:"minecraft:honey_bottle",count:1})}><Plus size={16}/>Result hinzufügen</Button>
        </div>
      </div>
    </div>
  );
};

const fillingAdapter: RecipeAdapter<FillingPayload> = {
  id: "create.filling",
  title: "Create: Filling",
  icon: <Cog size={16} />,
  defaults: { item: null, fluid: { id: "minecraft:water", amount: 1000 }, results: [{ id: "minecraft:honey_bottle", count: 1 }], recipeId: "example:create_filling" },
  Editor: FillingEditor,
  validate: p => { const m=[] as any[]; if(!p.item) m.push({level:'error',msg:'Item fehlt.'}); if(!p.fluid) m.push({level:'error',msg:'Fluid fehlt.'}); if(!p.results?.length)m.push({level:'error',msg:'Mindestens ein Result wird benötigt.'}); return m; },
  toKubeJS: p => {
    const obj:any = { type:"create:filling", ingredients: [ itemToJson({...(p.item as ItemLike),count:1}), fluidToJson(p.fluid!) ], results: p.results.map(outputToJson) };
    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};

// ---------- Create: Emptying ----------
type EmptyingPayload = { input: ItemLike | null; itemResults: OutputLike[]; fluid?: FluidLike | null; recipeId?: string };

const coerceEmptying=(v:any,id:string,d:EmptyingPayload)=>!v||v.__type!==id?tagPayload(id,d):({__type:id,input:cleanItem(v.input)||null,itemResults:Array.isArray(v.itemResults)?v.itemResults.filter(Boolean):d.itemResults,fluid:cleanFluid(v.fluid),recipeId:v.recipeId} as any);

const EmptyingEditor: RecipeAdapter<EmptyingPayload>["Editor"] = ({ value, onChange }) => {
  const safe = coerceEmptying(value as any, "create.emptying", emptyingAdapter.defaults);
  const setOut=(i:number,out:OutputLike|null)=>{const arr=safe.itemResults.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,itemResults:arr});};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
            const id=prompt("Item", safe.input?.id||"minecraft:"); if(!id)return;
            const nbt=prompt("NBT as JSON (optional)", safe.input?.nbt||"");
            onChange({...safe,input:cleanItem({id, count:1, nbt})});
          }}>{safe.input?safe.input.id:<span className="opacity-40">Empty</span>}</button>
          <Button variant="ghost" onClick={()=>onChange({...safe,input:null})}><Trash2 size={16}/>Clear</Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <Label>Fluid Result (optional) – id</Label>
            <Input placeholder="minecraft:water" value={safe.fluid?.id||''} onChange={e=>onChange({...safe,fluid:cleanFluid({ ...(safe.fluid||{}), id:e.target.value, amount:safe.fluid?.amount??1000 })})}/>
          </div>
          <div>
            <Label>Fluid Amount (mb)</Label>
            <Input type="number" min={1} placeholder="1000" value={safe.fluid?.amount??''} onChange={e=>onChange({...safe,fluid:cleanFluid({ ...(safe.fluid||{}), id:safe.fluid?.id||'minecraft:water', amount:Math.max(1,parseInt(e.target.value||'1',10)||1) })})}/>
          </div>
        </div>
      </div>
      <div>
        <Label>Item Results (optional)</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.itemResults.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:glass_bottle" value={o.id} onChange={e=>setOut(i,{...o,id:e.target.value})}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOut(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance" value={o.chance??''} onChange={e=>setOut(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>setOut(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setOut(safe.itemResults.length,{id:"minecraft:glass_bottle",count:1})}><Plus size={16}/>Item-Result hinzufügen</Button>
        </div>
      </div>
    </div>
  );
};

const emptyingAdapter: RecipeAdapter<EmptyingPayload> = {
  id: "create.emptying",
  title: "Create: Emptying",
  icon: <Cog size={16} />,
  defaults: { input: null, itemResults: [], fluid: { id: "minecraft:water", amount: 1000 }, recipeId: "example:create_emptying" },
  Editor: EmptyingEditor,
  validate: p => { const m=[] as any[]; if(!p.input)m.push({level:'error',msg:'Input Item missing!'}); if(!p.itemResults?.length && !p.fluid) m.push({level:'warn',msg:'Weder Item- noch Fluid-Result gesetzt.'}); return m; },
  toKubeJS: p => {
    const results:any[] = [...(p.itemResults||[]).map(outputToJson)];
    if (p.fluid) results.push(fluidToJson(p.fluid));
    const obj:any = { type:"create:emptying", ingredients: p.input?[itemToJson({...(p.input as ItemLike),count:1})]:[], results };
    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};


// ---------- Create: Deploying ----------
type DeployingPayload = {
  inputs: (ItemLike | null)[];
  outputs: OutputLike[];
  keepHeldItem?: boolean;    // <— NEU
  recipeId?: string;
};

const coerceDeploying = (v:any,id:string,d:DeployingPayload)=>{
  if(!v||v.__type!==id) return tagPayload(id,d);
  const inputs = Array.isArray(v.inputs)?v.inputs.slice(0,2).map((x:any)=>cleanItem(x)||null):[null,null];
  while(inputs.length<2) inputs.push(null);
  const outputs = Array.isArray(v.outputs)?v.outputs.filter(Boolean):d.outputs;
  const keepHeldItem = typeof v.keepHeldItem === 'boolean' ? v.keepHeldItem : false; // <— NEU
  return { __type:id, inputs, outputs, keepHeldItem, recipeId:v.recipeId } as any;   // <— NEU
};

const DeployingEditor: RecipeAdapter<DeployingPayload>["Editor"] = ({ value, onChange }) => {
  const safe = coerceDeploying(value as any, "create.deploying", deployingAdapter.defaults);
  const setInput=(i:number,it:ItemLike|null)=>{const arr=safe.inputs.slice(); arr[i]=it; onChange({...safe,inputs:arr});};
  const setOutput=(i:number,out:OutputLike|null)=>{const arr=safe.outputs.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,outputs:arr});};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Inputs (Basis + Hinzugeben)</Label>
        <div className="mt-2 flex flex-col gap-2">
          {["Basis (unten)", "Hinzu (oben)"].map((lbl, i)=>(
            <div key={i} className="grid grid-cols-5 gap-2 items-center">
              <Input className="col-span-3" placeholder={i===0?"minecraft:iron_ingot":"minecraft:plate"} value={safe.inputs[i]?.id||''} onChange={e=>setInput(i, cleanItem({ ...(safe.inputs[i]||{}), id:e.target.value, count:1 }))}/>
              <Button variant="ghost" onClick={()=>setInput(i,null)}><Trash2 size={16}/>Clear</Button>
              <Button variant="outline" onClick={()=>setInput(i, cleanItem({ id:safe.inputs[i]?.id||'minecraft:', count:1, nbt: prompt('NBT as JSON (optional)', safe.inputs[i]?.nbt||'')||undefined }))}>NBT</Button>
            </div>
          ))}
          <div className="mt-4">
            <Label>Optionen</Label>
            <div className="mt-2">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={!!safe.keepHeldItem}
                  onChange={(e)=>onChange({ ...safe, keepHeldItem: e.target.checked })}
                />
                Keep Hand (Item nicht verbrauchen)
              </label>
            </div>
          </div>
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_plate" value={o.id} onChange={e=>setOutput(i,{...o,id:e.target.value})}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOutput(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance" value={o.chance??''} onChange={e=>setOutput(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>setOutput(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setOutput(safe.outputs.length,{id:"minecraft:iron_ingot",count:1})}><Plus size={16}/>Output hinzufügen</Button>
        </div>
      </div>
    </div>
  );
};

const deployingAdapter: RecipeAdapter<DeployingPayload> = {
  id: "create.deploying",
  title: "Create: Deploying",
  icon: <Cog size={16} />,
  defaults: {
  inputs: [null,null],
  outputs: [{ id: "minecraft:iron_ingot", count: 1 }],
  keepHeldItem: false,                // <— NEU
  recipeId: "example:create_deploying"
},
  Editor: DeployingEditor,
  validate: p => { const m=[] as any[]; if(!(p.inputs?.[0]&&p.inputs?.[1])) m.push({level:'error',msg:'Beide Inputs benötigt (Basis + Hinzu).'}); if(!p.outputs?.length)m.push({level:'error',msg:'Mindestens ein Output wird benötigt.'}); return m; },
  toKubeJS: p => {
    const obj:any = {
      type:"create:deploying",
      ingredients: p.inputs.filter(Boolean).map(i=>itemToJson({...(i as ItemLike),count:1})),
      results: p.outputs.map(outputToJson)
    };
    if (p.keepHeldItem) obj.keepHeldItem = true;   // <— NEU

    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};


// ---------- Create: Cutting ----------
type CuttingPayload = { input: ItemLike | null; outputs: OutputLike[]; processingTime?: number; recipeId?: string };

const coerceCutting = (v:any,id:string,d:CuttingPayload)=>!v||v.__type!==id?tagPayload(id,d):({__type:id,input:cleanItem(v.input)||null,outputs:Array.isArray(v.outputs)?v.outputs.filter(Boolean):d.outputs,processingTime:typeof v.processingTime==='number'?Math.max(1,v.processingTime):undefined,recipeId:v.recipeId} as any);

const CuttingEditor: RecipeAdapter<CuttingPayload>["Editor"] = ({ value, onChange }) => {
  const safe = coerceCutting(value as any, "create.cutting", cuttingAdapter.defaults);
  const setOutput=(i:number,out:OutputLike|null)=>{const arr=safe.outputs.slice(); if(out) arr[i]=out; else arr.splice(i,1); onChange({...safe,outputs:arr});};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={()=>{
            const id=prompt("Input Item/Tag", safe.input?.id||"minecraft:"); if(!id)return;
            const nbt=prompt("NBT as JSON (optional)", safe.input?.nbt||"");
            onChange({...safe,input:cleanItem({id, count:1, nbt})});
          }}>{safe.input?safe.input.id:<span className="opacity-40">Empty</span>}</button>
          <Button variant="ghost" onClick={()=>onChange({...safe,input:null})}><Trash2 size={16}/>Clear</Button>
        </div>
        <div className="mt-4">
          <Label>Processing Time (Ticks, optional)</Label>
          <Input type="number" min={1} placeholder="e.g. 100" value={safe.processingTime??''} onChange={e=>onChange({...safe,processingTime:e.target.value?Math.max(1,parseInt(e.target.value,10)||0):undefined})}/>
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o,i)=>(
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:stick" value={o.id} onChange={e=>setOutput(i,{...o,id:e.target.value})}/>
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count??1} onChange={e=>setOutput(i,{...o,count:Math.max(1,parseInt(e.target.value||'1',10)||1)})}/>
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance??''} onChange={e=>setOutput(i,{...o,chance:e.target.value===''?undefined:Math.max(0,Math.min(0.9999,parseFloat(e.target.value)))})}/>
              <Button variant="ghost" className="col-span-1" onClick={()=>setOutput(i,null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={()=>setOutput(safe.outputs.length,{id:"minecraft:stick",count:1})}><Plus size={16}/>Output hinzufügen</Button>
        </div>
      </div>
    </div>
  );
};

const cuttingAdapter: RecipeAdapter<CuttingPayload> = {
  id: "create.cutting",
  title: "Create: Cutting",
  icon: <Cog size={16} />,
  defaults: { input: null, outputs: [{ id: "minecraft:stick", count: 1 }], processingTime: undefined, recipeId: "example:create_cutting" },
  Editor: CuttingEditor,
  validate: p => { const m=[] as any[]; if(!p.input)m.push({level:'error',msg:'Input Item missing!'}); if(!p.outputs?.length)m.push({level:'error',msg:'Mindestens ein Output wird benötigt.'}); return m; },
  toKubeJS: p => {
    const obj:any = { type:"create:cutting", ingredients: p.input?[itemToJson({...(p.input as ItemLike),count:1})]:[], results: p.outputs.map(outputToJson) };
    if (p.processingTime && p.processingTime>0) obj.processingTime=p.processingTime;
    return [`event.custom(${JSON.stringify(obj,null,2)})${p.recipeId?`.id('${p.recipeId}')`:''};`];
  }
};


// ---------- Create: Pressing ----------
type PressingPayload = { input: ItemLike | null; outputs: OutputLike[]; processingTime?: number; recipeId?: string };

const coercePressing = (v: any, adapterId: string, defaults: PressingPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  return { __type: adapterId, input: cleanItem(v.input) || null, outputs: Array.isArray(v.outputs) ? v.outputs.filter(Boolean) : defaults.outputs, processingTime: typeof v.processingTime === 'number' ? Math.max(1, v.processingTime) : undefined, recipeId: v.recipeId } as any;
};

const PressingEditor: RecipeAdapter<PressingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coercePressing(value as any, "create.pressing", pressingAdapter.defaults);
  const setOutput = (i: number, out: OutputLike | null) => { const arr = safe.outputs.slice(); if (out) arr[i] = out; else arr.splice(i, 1); onChange({ ...safe, outputs: arr }); };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={() => {
            const id = prompt("Input Item/Tag", safe.input?.id || "minecraft:"); if (!id) return;
            const nbt = prompt("NBT as JSON (optional)", safe.input?.nbt || "");
            onChange({ ...safe, input: cleanItem({ id, count: 1, nbt }) });
          }}>{safe.input ? safe.input.id : <span className="opacity-40">Empty</span>}</button>
          <Button variant="ghost" onClick={() => onChange({ ...safe, input: null })}><Trash2 size={16}/>Clear</Button>
        </div>
        <div className="mt-4">
          <Label>Processing Time (Ticks, optional)</Label>
          <Input type="number" min={1} placeholder="e.g. 100" value={safe.processingTime ?? ''} onChange={e => onChange({ ...safe, processingTime: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 0) : undefined })} />
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:plate" value={o.id} onChange={e => setOutput(i, { ...o, id: e.target.value })} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count ?? 1} onChange={e => setOutput(i, { ...o, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })} />
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance ?? ''} onChange={e => setOutput(i, { ...o, chance: e.target.value === '' ? undefined : Math.max(0, Math.min(0.9999, parseFloat(e.target.value))) })} />
              <Button variant="ghost" className="col-span-1" onClick={() => setOutput(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <Button variant="outline" onClick={() => setOutput(safe.outputs.length, { id: "minecraft:iron_nugget", count: 1 })}><Plus size={16}/>Output hinzufügen</Button>
        </div>
      </div>
    </div>
  );
};

const pressingAdapter: RecipeAdapter<PressingPayload> = {
  id: "create.pressing",
  title: "Create: Pressing",
  icon: <Cog size={16} />,
  defaults: { input: null, outputs: [{ id: "minecraft:iron_nugget", count: 1 }], processingTime: undefined, recipeId: "example:create_pressing" },
  Editor: PressingEditor,
  validate: p => { const m=[] as any[]; if (!p.input) m.push({level:'error',msg:'Input Item missing!'}); if (!p.outputs?.length) m.push({level:'error',msg:'Mindestens ein Output wird benötigt.'}); return m; },
  toKubeJS: p => {
    const obj: any = { type: "create:pressing", ingredients: p.input ? [itemToJson({ ...(p.input as ItemLike), count: 1 })] : [], results: p.outputs.map(outputToJson) };
    if (p.processingTime && p.processingTime > 0) obj.processingTime = p.processingTime;
    return [`event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId ? `.id('${p.recipeId}')` : ''};`];
  }
};


type MillingPayload = { input: ItemLike | null; outputs: OutputLike[]; processingTime?: number; recipeId?: string };
const coerceMilling = (v: any, adapterId: string, defaults: MillingPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const input = cleanItem(v.input) || null;
  const outputs = Array.isArray(v.outputs) && v.outputs.length ? v.outputs.map((o: any) => cleanItem(o) ? { ...o } : null).filter(Boolean) as OutputLike[] : defaults.outputs;
  const processingTime = typeof v.processingTime === 'number' ? Math.max(1, v.processingTime) : undefined;
  return { __type: adapterId, input, outputs, processingTime, recipeId: v.recipeId } as any;
};

const MillingEditor: RecipeAdapter<MillingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceMilling(value as any, "create.milling", millingAdapter.defaults);
  const setOutput = (idx: number, out: OutputLike | null) => { const outputs = safe.outputs.slice(); if (out) outputs[idx] = out; else outputs.splice(idx, 1); onChange({ ...safe, outputs }); };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={() => {
            const id = prompt("Input Item/Tag", safe.input?.id || "minecraft:"); if (!id) return;
            const count = Math.max(1, parseInt(prompt("Menge", String(safe.input?.count ?? 1)) || '1', 10));
            const nbt = prompt("NBT as JSON (optional)", safe.input?.nbt || "");
            onChange({ ...safe, input: cleanItem({ id, count, nbt }) });
          }}>
            {safe.input ? `${safe.input.count ?? 1}× ${safe.input.id}` : <span className="opacity-40">Empty</span>}
          </button>
          <Button variant="ghost" onClick={() => onChange({ ...safe, input: null })}><Trash2 size={16}/>Clear</Button>
        </div>
        <div className="mt-4">
          <Label>Processing Time (Ticks, optional)</Label>
          <Input type="number" min={1} placeholder="e.g. 100" value={safe.processingTime ?? ''} onChange={e => onChange({ ...safe, processingTime: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 0) : undefined })} />
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:wheat_seeds" value={o.id} onChange={e => setOutput(i, { ...o, id: e.target.value })} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count ?? 1} onChange={e => setOutput(i, { ...o, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })} />
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance ?? ''} onChange={e => setOutput(i, { ...o, chance: e.target.value === '' ? undefined : Math.max(0, Math.min(0.9999, parseFloat(e.target.value))) })} />
              <Button variant="ghost" className="col-span-1" onClick={() => setOutput(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <div>
            <Button variant="outline" onClick={() => setOutput(safe.outputs.length, { id: "minecraft:wheat_seeds", count: 1 })}><Plus size={16}/>Output hinzufügen</Button>
          </div>
        </div>
        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={() => onChange({ ...safe, outputs: [...safe.outputs, { id, count: 1 }] })}>{id}</Pill>
            ))}
          </div>
        </div>
        <div className="mt-4">
        </div>
      </div>
    </div>
  );
};

const millingAdapter: RecipeAdapter<MillingPayload> = {
  id: "create.milling",
  title: "Create: Milling",
  icon: <Cog size={16} />,
  defaults: { input: null, outputs: [{ id: "minecraft:wheat_seeds", count: 1 }], processingTime: undefined, recipeId: "example:create_milling" },
  Editor: MillingEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!p.input) msgs.push({ level: 'error', msg: 'Input Item missing!' });
    if (!p.outputs?.length) msgs.push({ level: 'error', msg: 'Mindestens ein Output wird benötigt.' });
    return msgs;
  },
  toKubeJS: (p) => {
    const obj: any = {
      type: "create:milling",
      ingredients: p.input ? [itemToJson(p.input)] : [],
      results: p.outputs.map(outputToJson)
    };
    if (p.processingTime && p.processingTime > 0) obj.processingTime = p.processingTime;

    const line = `event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId ? `.id('${p.recipeId}')` : ''};`;
    return [line];
  }
};

// Create: Crushing

type CrushingPayload = { input: ItemLike | null; outputs: OutputLike[]; processingTime?: number; recipeId?: string };
const coerceCrushing = (v: any, adapterId: string, defaults: CrushingPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const input = cleanItem(v.input) || null;
  const outputs = Array.isArray(v.outputs) && v.outputs.length ? v.outputs.map((o: any) => cleanItem(o) ? { ...o } : null).filter(Boolean) as OutputLike[] : defaults.outputs;
  const processingTime = typeof v.processingTime === 'number' ? Math.max(1, v.processingTime) : undefined;
  return { __type: adapterId, input, outputs, processingTime, recipeId: v.recipeId } as any;
};

const CrushingEditor: RecipeAdapter<CrushingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceCrushing(value as any, "create.crushing", crushingAdapter.defaults);
  const setOutput = (idx: number, out: OutputLike | null) => { const outputs = safe.outputs.slice(); if (out) outputs[idx] = out; else outputs.splice(idx, 1); onChange({ ...safe, outputs }); };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Input</Label>
        <div className="mt-2 grid grid-cols-3 gap-2 w-56">
          <button className="h-14 rounded-xl border bg-white hover:bg-gray-50 flex items-center justify-center text-xs" onClick={() => {
            const id = prompt("Input Item/Tag", safe.input?.id || "minecraft:"); if (!id) return;
            const count = Math.max(1, parseInt(prompt("Menge", String(safe.input?.count ?? 1)) || '1', 10));
            const nbt = prompt("NBT as JSON (optional)", safe.input?.nbt || "");
            onChange({ ...safe, input: cleanItem({ id, count, nbt }) });
          }}>
            {safe.input ? `${safe.input.count ?? 1}× ${safe.input.id}` : <span className="opacity-40">Empty</span>}
          </button>
          <Button variant="ghost" onClick={() => onChange({ ...safe, input: null })}><Trash2 size={16}/>Clear</Button>
        </div>
        <div className="mt-4">
          <Label>Processing Time (Ticks, optional)</Label>
          <Input type="number" min={1} placeholder="e.g. 100" value={safe.processingTime ?? ''} onChange={e => onChange({ ...safe, processingTime: e.target.value ? Math.max(1, parseInt(e.target.value, 10) || 0) : undefined })} />
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:gravel" value={o.id} onChange={e => setOutput(i, { ...o, id: e.target.value })} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count ?? 1} onChange={e => setOutput(i, { ...o, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })} />
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance ?? ''} onChange={e => setOutput(i, { ...o, chance: e.target.value === '' ? undefined : Math.max(0, Math.min(0.9999, parseFloat(e.target.value))) })} />
              <Button variant="ghost" className="col-span-1" onClick={() => setOutput(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <div>
            <Button variant="outline" onClick={() => setOutput(safe.outputs.length, { id: "minecraft:gravel", count: 1 })}><Plus size={16}/>Output hinzufügen</Button>
          </div>
        </div>
        <div className="mt-4">
        </div>
      </div>
    </div>
  );
};

const crushingAdapter: RecipeAdapter<CrushingPayload> = {
  id: "create.crushing",
  title: "Create: Crushing",
  icon: <Cog size={16} />,
  defaults: { input: null, outputs: [{ id: "minecraft:gravel", count: 1 }], processingTime: undefined, recipeId: "example:create_crushing" },
  Editor: CrushingEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!p.input) msgs.push({ level: 'error', msg: 'Input Item missing!' });
    if (!p.outputs?.length) msgs.push({ level: 'error', msg: 'Mindestens ein Output wird benötigt.' });
    return msgs;
  },
  toKubeJS: (p) => {
    const obj: any = {
      type: "create:crushing",
      ingredients: p.input ? [itemToJson(p.input)] : [],
      results: p.outputs.map(outputToJson)
    };
    if (p.processingTime && p.processingTime > 0) obj.processingTime = p.processingTime;

    const line = `event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId ? `.id('${p.recipeId}')` : ''};`;
    return [line];
  }
};

// Create: Mixing

type Heating = 'none' | 'heated' | 'superheated';

type MixingPayload = { inputs: (ItemLike | null)[]; outputs: OutputLike[]; heat?: Heating; recipeId?: string };
const coerceMixing = (v: any, adapterId: string, defaults: MixingPayload) => {
  if (!v || v.__type !== adapterId) return tagPayload(adapterId, defaults);
  const inputs = Array.isArray(v.inputs) ? v.inputs.filter((x: any, i: number) => i < 9) : [];
  const outputs = Array.isArray(v.outputs) && v.outputs.length ? v.outputs.map((o: any) => cleanItem(o) ? { ...o } : null).filter(Boolean) as OutputLike[] : defaults.outputs;
  const heat: Heating = v.heat === 'heated' || v.heat === 'superheated' ? v.heat : 'none';
  while (inputs.length < 2) inputs.push(null); // at least 2 slots visible
  return { __type: adapterId, inputs, outputs, heat, recipeId: v.recipeId } as any;
};

const MixingEditor: RecipeAdapter<MixingPayload>["Editor"] = ({ value, onChange, itemPalette }) => {
  const safe = coerceMixing(value as any, "create.mixing", mixingAdapter.defaults);
  const setInput = (idx: number, item: ItemLike | null) => { const inputs = safe.inputs.slice(); inputs[idx] = item; onChange({ ...safe, inputs }); };
  const setOutput = (idx: number, out: OutputLike | null) => { const outputs = safe.outputs.slice(); if (out) outputs[idx] = out; else outputs.splice(idx, 1); onChange({ ...safe, outputs }); };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Label>Inputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.inputs.map((cell, i) => (
            <div key={i} className="grid grid-cols-5 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_ingot" value={cell?.id || ''} onChange={e => setInput(i, cleanItem({ ...(cell || {}), id: e.target.value }))} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={cell?.count ?? 1} onChange={e => setInput(i, cleanItem({ ...(cell || {}), count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) }))} />
              <Button variant="ghost" onClick={() => setInput(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <div>
            <Button variant="outline" onClick={() => setInput(safe.inputs.length, null)}><Plus size={16}/>Input hinzufügen</Button>
          </div>
        </div>
        <div className="mt-4">
          <Label>Hitze</Label>
          <div className="mt-2 flex gap-2">
            {(["none","heated","superheated"] as Heating[]).map(h => (
              <Pill key={h} active={(safe.heat||'none')===h} onClick={() => onChange({ ...safe, heat: h })}>{h}</Pill>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Label>Outputs</Label>
        <div className="mt-2 flex flex-col gap-2">
          {safe.outputs.map((o, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-center">
              <Input className="col-span-3" placeholder="minecraft:iron_nugget" value={o.id} onChange={e => setOutput(i, { ...o, id: e.target.value })} />
              <Input type="number" min={1} className="col-span-1" placeholder="Menge" value={o.count ?? 1} onChange={e => setOutput(i, { ...o, count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })} />
              <Input type="number" step="0.01" min={0} max={0.9999} className="col-span-1" placeholder="Chance (0-1)" value={o.chance ?? ''} onChange={e => setOutput(i, { ...o, chance: e.target.value === '' ? undefined : Math.max(0, Math.min(0.9999, parseFloat(e.target.value))) })} />
              <Button variant="ghost" className="col-span-1" onClick={() => setOutput(i, null)}><Trash2 size={16}/></Button>
            </div>
          ))}
          <div>
            <Button variant="outline" onClick={() => setOutput(safe.outputs.length, { id: "minecraft:iron_nugget", count: 1 })}><Plus size={16}/>Output hinzufügen</Button>
          </div>
        </div>
        <div className="mt-4">
          <Label>Quicktags</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {itemPalette.map(id => (
              <Pill key={id} onClick={() => onChange({ ...safe, outputs: [...safe.outputs, { id, count: 1 }] })}>{id}</Pill>
            ))}
          </div>
        </div>
        <div className="mt-4">
        </div>
      </div>
    </div>
  );
};

const mixingAdapter: RecipeAdapter<MixingPayload> = {
  id: "create.mixing",
  title: "Create: Mixing",
  icon: <Cog size={16} />,
  defaults: { inputs: [null, null], outputs: [{ id: "minecraft:iron_nugget", count: 1 }], heat: 'none', recipeId: "example:create_mixing" },
  Editor: MixingEditor,
  validate: (p) => {
    const msgs: { level: "error" | "warn"; msg: string }[] = [];
    if (!Array.isArray(p.inputs) || !p.inputs.filter(Boolean).length) msgs.push({ level: 'error', msg: 'Mindestens ein Input wird benötigt.' });
    if (!Array.isArray(p.outputs) || !p.outputs.length) msgs.push({ level: 'error', msg: 'Mindestens ein Output wird benötigt.' });
    return msgs;
  },
  toKubeJS: (p) => {
    const obj: any = {
      type: "create:mixing",
      ingredients: expandForIngredients(p.inputs),  // <— hier!
      results: p.outputs.map(outputToJson)
    };
    if (p.heat === 'heated') obj.heat_requirement = "heated";
    if (p.heat === 'superheated') obj.heat_requirement = "superheated";
    // Bei 'none' wird heat_requirement weggelassen – genau wie gewünscht.

    const line = `event.custom(${JSON.stringify(obj, null, 2)})${p.recipeId ? `.id('${p.recipeId}')` : ''};`;
    return [line];
  }
};

// ---------- Mod Plugins ----------

const VANILLA_PLUGIN: ModPlugin = { id: "vanilla", title: "Vanilla", adapters: [shapedAdapter, shapelessAdapter, smeltingAdapter] };
const CREATE_PLUGIN: ModPlugin = {
  id: "create",
  title: "Create",
  adapters: [
    millingAdapter,
    crushingAdapter,
    mixingAdapter,
    pressingAdapter,
    cuttingAdapter,
    deployingAdapter,
    fillingAdapter,
    emptyingAdapter,
    splashingAdapter,
    smokingAdapter,
    blastingFanAdapter,
    hauntingAdapter,
    compactingAdapter,
    mechanicalAdapter,
    sequencedAdapter
  ]
};
const CUSTOM_PLUGIN: ModPlugin = { id: "custom", title: "Custom", adapters: [customAdapter] };
const PLUGINS: ModPlugin[] = [VANILLA_PLUGIN, CREATE_PLUGIN, CUSTOM_PLUGIN];

function getAdapterById(id: string) {
  for (const p of PLUGINS) {
    const a = p.adapters.find(x => x.id === id);
    if (a) return a;
  }
  return undefined;
}

// ------ Tool Tip --------
const EditorTip: React.FC = () => (
  <div className="mb-4 rounded-xl border-2 border-black bg-white text-black p-3 text-sm">
    <span className="font-semibold">Tip:</span>{' '}
    Enable advanced tooltips with{' '}
    <span className="inline-flex items-center gap-1">
      <kbd className="px-1.5 py-0.5 border border-black rounded-md bg-white text-black">F3</kbd>
      <span>+</span>
      <kbd className="px-1.5 py-0.5 border border-black rounded-md bg-white text-black">H</kbd>
    </span>{' '}
    to see item IDs (e.g. <code className="font-mono">minecraft:stick</code>) in-game.
    For tags like <code className="font-mono">#forge:ingots/iron</code>, use JEI/REI or a tag viewer.
  </div>
);




// ---------- Main App ----------

export default function App() {
  // App Config
  const [platform, setPlatform] = useState<Platform>("NeoForge");
  const [mcVersion, setMcVersion] = useState<string>("1.21.1");
  const [kubeVersion, setKubeVersion] = useState<string>("2101.7.1-build.181");
  const [recipeIdSuffix, setRecipeIdSuffix] = useState<string>("");


  // Mod & Adapter selection
  const [activeModId, setActiveModId] = useState<string>(PLUGINS[0].id);
  const activePlugin = useMemo(() => PLUGINS.find(p => p.id === activeModId)!, [activeModId]);
  const [activeAdapterId, setActiveAdapterId] = useState<string>(activePlugin.adapters[0].id);
  const activeAdapter = useMemo(() => getAdapterById(activeAdapterId)!, [activeAdapterId]);
  const [editorValue, setEditorValue] = useState<any>(tagPayload(activeAdapter.id, activeAdapter.defaults));

  // Remount Editor on adapter change & reset payload immediately to avoid transient undefined
  useEffect(() => { setEditorValue(tagPayload(activeAdapter.id, activeAdapter.defaults)); }, [activeAdapterId]);
  useEffect(() => { setActiveAdapterId(activePlugin.adapters[0].id); }, [activePlugin]);

  // Project
  const [project, setProject] = useState<ProjectRecipe[]>([]);
  const itemPalette = useMemo(() => ([
    "minecraft:stick", "minecraft:planks", "minecraft:oak_planks", "minecraft:cobblestone",
    "minecraft:iron_ingot", "minecraft:gold_ingot", "minecraft:diamond", "minecraft:redstone",
    "minecraft:wheat", "minecraft:wheat_seeds", "minecraft:wheat", "minecraft:bread",
    "minecraft:gold_ingot", "minecraft:coal"
  ]), []);

  const addToProject = useCallback(() => {
    const errs = activeAdapter.validate(editorValue).filter(m => m.level === 'error');

    const cleanSuffix = normalizeRecipeSuffix(recipeIdSuffix);
    if (!cleanSuffix) {
      alert('Bitte gib eine Recipe ID ein (z. B. "iron_nugget_from_mixing").');
      return;
    }

    if (errs.length) {
      alert(`Bitte behebe zuerst Fehler:\n- ${errs.map(e => e.msg).join('\n- ')}`);
      return;
    }

    const { __type, ...payload } = editorValue || {};
    const entry: ProjectRecipe = {
      id: uid(),
      type: activeAdapter.id,
      // WICHTIG: hartes Prefix 'shadoukube:' erzwingen
      payload: { ...payload, recipeId: `shadoukube:${cleanSuffix}` },
      label: `${activeAdapter.title}`
    };

    setProject(prev => [...prev, entry]);
  }, [activeAdapter, editorValue, recipeIdSuffix]);


  const removeFromProject = useCallback((id: string) => setProject(prev => prev.filter(r => r.id !== id)), []);

  // Generate KubeJS file content
  const kubeJs = useMemo(() => generateKubeJs(project, { platform, mcVersion, kubeVersion }), [project, platform, mcVersion, kubeVersion]);

  // Blob URL lifecycle
  const [downloadHref, setDownloadHref] = useState<string>("");
  useEffect(() => {
    const blob = new Blob([kubeJs], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setDownloadHref(url);
    return () => URL.revokeObjectURL(url);
  }, [kubeJs]);
 
  // UI
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-sky-50 text-gray-900">
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <motion.div initial={{ rotate: -10, scale: 0.9 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 12 }} className="w-10 h-10 rounded-2xl bg-indigo-600 text-white grid place-items-center shadow-md">
              <Layers size={20} />
            </motion.div>
            <div>
              <h1 className="text-2xl font-bold">KubeJS Recipe Builder</h1>
              <p className="text-xs opacity-70">Made by <a href= "https://shadoukita.com/" target="_blank">Shadoukita</a></p>
            </div>
          </div>
          <div className="flex items-center gap-2">
          </div>
        </header>

        {/* CONFIG */}


        {/* EDITOR */}
        <Section title="Rezept-Editor" right={<span className="text-xs opacity-70"></span>}>
          {/* Mod selection */}
          <div className="flex flex-wrap gap-2 mb-2">
            {PLUGINS.map(mod => (
              <Pill key={mod.id} active={activeModId === mod.id} onClick={() => setActiveModId(mod.id)}>
                {mod.title}
              </Pill>
            ))}
          </div>
          {/* Adapter selection within chosen mod */}
          <div className="flex flex-wrap gap-2 mb-4">
            {activePlugin.adapters.map(ad => (
              <Pill key={ad.id} active={activeAdapterId === ad.id} onClick={() => setActiveAdapterId(ad.id)}>
                <span className="inline-flex items-center gap-1">{ad.icon}{ad.title}</span>
              </Pill>
            ))}
          </div>
          <EditorTip />

          {/* Key forces remount so Editors never render with stale payloads */}
          <activeAdapter.Editor key={activeAdapter.id} value={editorValue} onChange={setEditorValue} itemPalette={itemPalette} />

          {/* Validation */}
          <div className="mt-4">
            {activeAdapter.validate(editorValue).map((v, i) => (
              <div key={i} className={`text-sm ${v.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>• {v.msg}</div>
            ))}
          </div>
          {/* Recipe-ID global (Pflicht) */}
          <div className="mt-4 grid gap-2 max-w-md">
            <Label>Recipe ID:</Label>
            <Input
              placeholder="iron_nugget_from_mixing"
              value={recipeIdSuffix}
              onChange={(e) => setRecipeIdSuffix(e.target.value)}
            />
            <div className="text-base opacity-60">
              Name your Recipe with a <b>{'{Recipe ID}'}</b>.
            </div>
            <div className="text-xs opacity-60">
             This must be unique, no duplicates or the recipe wont work.
            </div>
          </div>
            <div className="mt-4">
              <div className="flex gap-2">
                <Button
                  onClick={addToProject}
                  disabled={!normalizeRecipeSuffix(recipeIdSuffix)}
                  className="disabled:bg-red-600 disabled:hover:bg-red-600 disabled:text-white disabled:opacity-100 disabled:cursor-not-allowed"
                  title={!normalizeRecipeSuffix(recipeIdSuffix) ? "Please enter a Recipe ID." : undefined}
                >
                  <Plus size={16}/>Add to Project
                </Button>
              </div>

              {!normalizeRecipeSuffix(recipeIdSuffix) && (
                <div className="mt-2 text-xs text-red-600">
                  Please enter a Recipe ID.
                </div>
              )}
            </div>
        </Section>
        

        {/* PROJECT */}
        <Section title="Project-Recipes" right={<span className="text-xs opacity-70">{project.length} Entries</span>}>
          {project.length === 0 ? (
            <div className="text-sm opacity-70">No recipes in the project yet. Add one at the top.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {project.map((r, idx) => {
                const adapter = getAdapterById(r.type)!;
                return (
                  <div key={r.id} className="rounded-xl border p-3 bg-white/70">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {adapter.icon}
                        <span>{adapter.title}</span>
                        <span className="opacity-50">#{idx + 1}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => removeFromProject(r.id)}><Trash2 size={16}/>Delete</Button>
                      </div>
                    </div>
                    <pre className="mt-2 text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto">{adapter.toKubeJS(r.payload).join("\n")}</pre>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* KUBEJS OUTPUT */}
        <Section title="Generated KubeJS-Code" right={<span className="text-xs opacity-70">/kubejs/server_scripts/recipes.js</span>}>
          <pre className="text-sm bg-gray-900 text-green-200 rounded-xl p-4 overflow-x-auto whitespace-pre">{kubeJs}</pre>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(kubeJs); }}><Copy size={16}/>Copy</Button>
            <a href={downloadHref} download="recipes.js" className="px-3 py-2 rounded-xl text-sm border hover:bg-gray-50 flex items-center gap-2"><Download size={16}/>save recipes.js</a>
          </div>
        </Section>

        <footer className="mt-10 text-xs opacity-60">
          <p>Config: Modloader <b>{platform}</b> • MC <b>{mcVersion}</b> • KubeJS <b>{kubeVersion}</b></p>
        </footer>
      </div>
    </div>
  );
}

// ---------- Code Generation ----------

function generateKubeJs(project: ProjectRecipe[], meta: { platform: Platform; mcVersion: string; kubeVersion: string }) {
  const lines: string[] = [];
  lines.push(`// Auto-generated by KubeJS Recipe Builder`);
  lines.push(`// Tool made by Shadoukita`);
  lines.push(`// Platform: ${meta.platform} | Minecraft ${meta.mcVersion} | KubeJS ${meta.kubeVersion}`);
  lines.push(`// Place in: kubejs/server_scripts/recipes.js`);
  lines.push("");
  lines.push("ServerEvents.recipes(event => {");
  lines.push("  // --- Recipes ---");
  for (const r of project) {
    const adapter = getAdapterById(r.type);
    if (!adapter) continue;
    const body = adapter.toKubeJS(r.payload);
    for (const b of body) lines.push("  " + b);
  }
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

// ---------- Dev Self-Tests (lightweight) ----------

function runDevTests() {
  try {
    // Shaped pattern trim & key
    const shaped: ShapedPayload = { result: { id: 'minecraft:stick', count: 2 }, grid: [ [null, {id:'minecraft:planks',count:1}, null], [null,{id:'minecraft:planks',count:1},null], [null,null,null] ] };
    const { pattern, key } = deriveShapedPattern(shaped.grid);
    console.assert(pattern.length >= 1 && Object.keys(key).length >= 1, 'deriveShapedPattern failed');

    // Milling toKubeJS
    const mill: MillingPayload = { input: { id:'minecraft:wheat' }, outputs: [{ id:'minecraft:wheat_seeds', count:1 }], processingTime: 100 };
    const millLine = millingAdapter.toKubeJS(mill)[0];
    console.assert(millLine.includes('create.milling') && millLine.includes('.processingTime(100)'), 'milling toKubeJS failed');

    // Mixing heat flags
    const mix: MixingPayload = { inputs: [{id:'minecraft:iron_ingot'}], outputs:[{id:'minecraft:iron_nugget', count:1}], heat:'heated' };
    const mixLine = mixingAdapter.toKubeJS(mix)[0];
    console.assert(mixLine.includes('create.mixing') && mixLine.includes('.heated()'), 'mixing toKubeJS failed');

    // Mixing superheated
    const mix2: MixingPayload = { inputs: [{id:'minecraft:gold_ingot'}], outputs:[{id:'minecraft:gold_nugget', count:1}], heat:'superheated', recipeId: 'test:mix' };
    const mixLine2 = mixingAdapter.toKubeJS(mix2)[0];
    console.assert(mixLine2.includes('.superHeated()') && mixLine2.includes(".id('test:mix')"), 'mixing superheated/id failed');

    // Crushing
    const crush: CrushingPayload = { input: { id:'minecraft:cobblestone' }, outputs: [{ id:'minecraft:gravel', count:1 }], processingTime: 80 };
    const crushLine = crushingAdapter.toKubeJS(crush)[0];
    console.assert(crushLine.includes('create.crushing') && crushLine.includes('.processingTime(80)'), 'crushing toKubeJS failed');

    // Shapeless validation & toKubeJS with id
    const shpLess: ShapelessPayload = { result: { id: 'minecraft:bread', count: 1 }, inputs: [ {id:'minecraft:wheat',count:1}, {id:'minecraft:wheat',count:1}, {id:'minecraft:wheat',count:1} ], recipeId: 'test:bread' };
    const valMsgs = shapelessAdapter.validate(shpLess);
    console.assert(!valMsgs.some(m => m.level==='error'), 'shapeless validation unexpectedly failed');
    const shpLine = shapelessAdapter.toKubeJS(shpLess)[0];
    console.assert(shpLine.includes("event.shapeless") && shpLine.includes(".id('test:bread')"), 'shapeless toKubeJS/id failed');

    // Coercers stable shapes
    const shapedCoerced = coerceShaped({ __type: 'vanilla.shaped', grid: [[null,null,null],[null,null,null],[null,null,null]], result: { id: 'minecraft:stick', count:2 } }, 'vanilla.shaped', shapedAdapter.defaults);
    console.assert(Array.isArray(shapedCoerced.grid) && shapedCoerced.grid.length===3, 'coerceShaped grid shape failed');

    const shapelessCoerced = coerceShapeless({ __type: 'vanilla.shapeless', inputs: [null], result: { id: 'minecraft:bread', count:1 } }, 'vanilla.shapeless', shapelessAdapter.defaults);
    console.assert(Array.isArray(shapelessCoerced.inputs) && shapelessCoerced.inputs.length===9, 'coerceShapeless inputs length failed');

    console.log('%cDEV TESTS PASSED', 'color: white; background: green; padding: 2px 6px;');
  } catch (e) {
    console.error('DEV TESTS FAILED', e);
  }
}

if (typeof window !== 'undefined' && (import.meta as any)?.env?.MODE !== 'production') {
  runDevTests();
}
