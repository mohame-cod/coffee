/* كوفي — واجهة أمامية فقط (HTML/CSS/JS)، بيانات تجريبية، بدون باك إند.
 * كل المنطق في هذا الملف: الحسابات، الحالة، المكوّنات، الشاشات. */
(function () {
  'use strict';
// ===== lib: money =====
  /**
   * Money & totals engine — pure functions, no I/O.
   *
   * All money is an INTEGER number of piastres (1 EGP = 100). Percentages are basis points
   * (14% = 1400). No binary floating point is used for financial totals.
   *
   * Formulas:
   *   lineTotal   = unitPrice × qty            (unitPrice already includes option surcharges)
   *   subtotal    = Σ lineTotal
   *   discount    = fixed: min(value, subtotal) | percent: round(subtotal × bps / 10000)
   *   line base   = lineTotal − discountAllocated(line)   (discount spread proportionally,
   *                                                        largest-remainder so the sum is exact)
   *   exclusive   : tax(line) = round(base × rate / 10000);        total = Σ base + Σ tax
   *   inclusive   : tax(line) = round(base × rate / (10000+rate)); total = Σ base
   *   net (ex-tax)= Σ (base − tax)  [inclusive]  or  Σ base  [exclusive]
   */

  class MoneyError extends Error {
    code;
    constructor(message, code = 'INVALID_INPUT') {
      super(message);
      this.code = code;
    }
  }

  /** Integer division with a rounding mode. n and d are integers, d > 0. */
  function roundDiv(n, d, mode = 'half_up') {
    if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0) {
      throw new MoneyError('roundDiv requires integers and a positive divisor');
    }
    const neg = n < 0;
    const a = Math.abs(n);
    let q = Math.floor(a / d);
    const r = a - q * d;
    if (mode === 'up') {
      if (r > 0) q += 1;
    } else if (mode === 'half_up') {
      if (r * 2 >= d) q += 1;
    }
    return neg ? -q : q;
  }

  /** Distribute `amount` across `weights` with the largest-remainder method; the sum is exact. */
  function allocate(amount, weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    if (amount === 0 || total === 0) return weights.map(() => 0);
    const base = weights.map((w) => Math.floor((amount * w) / total));
    let left = amount - base.reduce((s, x) => s + x, 0);
    const order = weights
      .map((w, i) => ({ i, frac: (amount * w) / total - Math.floor((amount * w) / total) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) base[order[k].i] += 1;
    return base;
  }

  function resolveDiscount(d, subtotal) {
    if (!d || !d.type || !(d.value > 0)) return { type: null, value: 0, amount: 0 };
    if (!Number.isInteger(d.value)) throw new MoneyError('قيمة الخصم غير صالحة');
    let amount;
    if (d.type === 'percent') {
      if (d.value > 10000) throw new MoneyError('نسبة الخصم لا يمكن أن تتجاوز 100%');
      amount = roundDiv(subtotal * d.value, 10000, 'half_up');
    } else {
      if (d.value > subtotal) throw new MoneyError('قيمة الخصم تتجاوز إجمالي الفاتورة');
      amount = d.value;
    }
    return { type: d.type, value: d.value, amount: Math.min(amount, subtotal) };
  }

  function calcTotals(lines, discount, tax) {
    for (const l of lines) {
      if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new MoneyError('سعر غير صالح');
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new MoneyError('كمية غير صالحة');
    }
    const rounding = tax.rounding ?? 'half_up';
    const lineTotals = lines.map((l) => l.unitPrice * l.qty);
    const subtotal = lineTotals.reduce((s, x) => s + x, 0);
    const d = resolveDiscount(discount, subtotal);
    const discAlloc = allocate(d.amount, lineTotals);
    const rate = tax.enabled ? tax.rateBps : 0;
    const inclusive = tax.mode === 'inclusive';

    const out = lines.map((l, i) => {
      const base = lineTotals[i] - discAlloc[i];
      let t = 0;
      if (rate > 0 && !l.taxExempt) {
        t = inclusive ? roundDiv(base * rate, 10000 + rate, rounding) : roundDiv(base * rate, 10000, rounding);
      }
      return {
        lineTotal: lineTotals[i],
        discountAlloc: discAlloc[i],
        taxAlloc: t,
        netAlloc: inclusive ? base - t : base,
        totalAlloc: inclusive ? base : base + t,
      };
    });
    const sum = (k) => out.reduce((s, x) => s + x[k], 0);
    return {
      lines: out,
      subtotal,
      discountType: d.type,
      discountValue: d.value,
      discountAmount: d.amount,
      taxAmount: sum('taxAlloc'),
      netSales: sum('netAlloc'),
      total: sum('totalAlloc'),
    };
  }

  /**
   * Validate and split payments. `payments` are the amounts handed over.
   * Cash may exceed the amount due (change is returned); non-cash may not.
   */
  function allocatePayments(total, payments, opts = {}) {
    const cashMethod = opts.cashMethod ?? 'cash';
    let cashTendered = 0;
    let nonCash = 0;
    const nonCashLines = [];
    for (const p of payments) {
      if (!Number.isInteger(p.amount) || p.amount < 0) throw new MoneyError('مبلغ الدفع غير صالح');
      if (p.amount === 0) continue;
      if (p.method === cashMethod) cashTendered += p.amount;
      else {
        nonCash += p.amount;
        nonCashLines.push({ method: p.method, amount: p.amount });
      }
    }
    if (nonCash > total) throw new MoneyError('المدفوعات غير النقدية تتجاوز إجمالي الفاتورة', 'OVERPAY_NONCASH');
    const dueAfterNonCash = total - nonCash;
    const cashApplied = Math.min(cashTendered, dueAfterNonCash);
    const change = cashTendered - cashApplied;
    const paid = nonCash + cashApplied;
    const remaining = total - paid;
    if (remaining > 0 && !opts.allowPartial) throw new MoneyError('المبلغ المدفوع أقل من إجمالي الفاتورة', 'UNDERPAID');
    if (total > 0 && paid === 0) throw new MoneyError('لا توجد مدفوعات', 'UNDERPAID');
    const lines = [...nonCashLines];
    if (cashTendered > 0) lines.unshift({ method: cashMethod, amount: cashApplied, tendered: cashTendered });
    return { lines, paid, remaining, change, cashApplied, cashTendered };
  }

  /** Amount refundable for `qty` units of one item. The last portion absorbs rounding. */
  function refundItemAmount(item, qty) {
    const left = item.qty - item.refundedQty;
    if (!Number.isInteger(qty) || qty <= 0) throw new MoneyError('كمية الاسترجاع غير صالحة');
    if (qty > left) throw new MoneyError('الكمية تتجاوز الكمية القابلة للاسترجاع', 'REFUND_EXCEEDS');
    if (qty === left) return item.totalAlloc - item.refundedAmount;
    return roundDiv(item.totalAlloc * qty, item.qty, 'half_up');
  }

  /** Expected physical cash. Card / wallet are excluded by construction. */
  function expectedCash(p) {
    return p.opening + p.cashSales + p.deposits - p.withdrawals - p.cashRefunds - (p.cashExpenses ?? 0);
  }

  /** Price excluding tax (one unit) — used for recipe margin. */
  function priceExTax(price, taxExempt, tax) {
    if (!tax.enabled || taxExempt || !tax.rateBps) return price;
    if (tax.mode === 'inclusive')
      return price - roundDiv(price * tax.rateBps, 10000 + tax.rateBps, tax.rounding ?? 'half_up');
    return price;
  }

// ===== lib: units =====
  /**
   * Unit conversion and recipe costing — pure functions.
   * Stock is stored in a BASE unit: g, ml or piece.
   * costPerBase = piastres per base unit (can be fractional). The recipe total rounds the exact sum once.
   */

  const TYPE_BASE = { weight: 'g', volume: 'ml', count: 'piece' };
  const UOM_TYPE_LABEL = { weight: 'وزن', volume: 'حجم', count: 'عدد', pack: 'تعبئة وتغليف', prep: 'تحضير' };
  const BASE_UNIT_LABEL = { g: 'جرام', ml: 'مللي', piece: 'قطعة' };
  let UOM = {};
  const UNITS = {}; // خريطة عرض مشتقة من UOM (الاسم فقط)؛ التحويل يتم عبر toBase

  function defaultUoms() {
    const f = (id, name, abbr, type, factor, decimals = 3) => ({ id, name, abbr, type, factor, decimals, active: true, builtin: true });
    const c = (id, name, abbr, type) => ({ id, name, abbr, type, factor: null, decimals: 2, active: true, builtin: true });
    return [
      f('mg', 'ملليجرام', 'mg', 'weight', 0.001), f('g', 'جرام', 'g', 'weight', 1), f('kg', 'كيلوجرام', 'kg', 'weight', 1000),
      f('ml', 'ملليلتر', 'ml', 'volume', 1), f('liter', 'لتر', 'L', 'volume', 1000), f('m3', 'متر مكعب', 'm³', 'volume', 1000000), f('floz', 'أونصة سائلة', 'fl oz', 'volume', 29.5735),
      f('tsp', 'ملعقة صغيرة', 'tsp', 'volume', 5), f('tbsp', 'ملعقة كبيرة', 'tbsp', 'volume', 15),
      f('piece', 'قطعة', 'pc', 'count', 1, 0), f('unit', 'وحدة', 'unit', 'count', 1, 0), f('habba', 'حبة', 'حبة', 'count', 1, 0), f('pair', 'زوج', 'pair', 'count', 2, 0), f('halfdozen', 'نصف دستة', '½dz', 'count', 6, 0), f('dozen', 'دستة', 'dz', 'count', 12, 0),
      c('pack', 'عبوة', 'pack', 'pack'), c('carton', 'كرتونة', 'ctn', 'pack'), c('crate', 'صندوق', 'crate', 'pack'), c('box', 'علبة', 'box', 'pack'), c('bottle', 'زجاجة', 'btl', 'pack'), c('jerrycan', 'جركن', 'jerry', 'pack'),
      c('bag', 'كيس', 'bag', 'pack'), c('sack', 'شوال', 'sack', 'pack'), c('packet', 'باكيت', 'pkt', 'pack'), c('bundle', 'حزمة', 'bndl', 'pack'), c('roll', 'رول', 'roll', 'pack'), c('can', 'كانز', 'can', 'pack'),
      c('jar', 'برطمان', 'jar', 'pack'), c('cup', 'كوب', 'cup', 'pack'), c('lid', 'غطاء', 'lid', 'pack'), c('straw', 'شاليموه', 'straw', 'pack'), c('sachet', 'ظرف', 'sachet', 'pack'), c('plate', 'طبق', 'plate', 'pack'), c('tray', 'صينية', 'tray', 'pack'),
      c('shot', 'شوت', 'shot', 'prep'), c('pump', 'ضغطة مضخة', 'pump', 'prep'), c('scoop', 'سكوب', 'scoop', 'prep'), c('serving', 'تقديم', 'serv', 'prep'), c('portion', 'حصة', 'portion', 'prep'),
      c('pinch', 'رشة', 'pinch', 'prep'), c('drop', 'قطرة', 'drop', 'prep'), c('slice', 'شريحة', 'slice', 'prep'),
    ];
  }
  function setUoms(list) {
    UOM = {};
    Object.keys(UNITS).forEach((k) => delete UNITS[k]);
    list.forEach((u) => { UOM[u.id] = u; UNITS[u.id] = { base: TYPE_BASE[u.type] || null, factor: u.factor || 0, label: u.name }; });
  }
  setUoms(defaultUoms());

  /** يحلّ وحدة إلى {base, factor}. الوحدات الثابتة لها معامل عام؛ وحدات التعبئة/التحضير تُعرَّف لكل خامة عبر item.convs. */
  function resolveUnit(item, id, depth = 0) {
    const u = UOM[id];
    if (!u) throw new Error(`وحدة غير معروفة: ${id}`);
    if (TYPE_BASE[u.type]) return { base: TYPE_BASE[u.type], factor: u.factor };
    const cv = item && item.convs && item.convs[id];
    if (!cv) throw new Error(`لم يُعرَّف تحويل «${u.name}» لهذه الخامة`);
    if (depth > 6) throw new Error('تحويلات دائرية أو متشعبة جدًا');
    const r = resolveUnit(item, cv.of, depth + 1);
    return { base: r.base, factor: cv.qty * r.factor };
  }

  /** يحوّل كمية إلى الوحدة الأساسية للخامة (g/ml/piece). لا تحويل بين الوزن والحجم إلا بكثافة (جرام لكل مللي). */
  function toBase(qty, unit, itemOrBase) {
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0) throw new Error('كمية غير صالحة');
    const item = typeof itemOrBase === 'string' ? { baseUnit: itemOrBase } : itemOrBase;
    const r = resolveUnit(item, unit);
    if (!(r.factor > 0) || !Number.isFinite(r.factor)) throw new Error('معامل تحويل غير صالح');
    if (r.base === item.baseUnit) return qty * r.factor;
    const d = Number(item.density);
    if (d > 0 && Number.isFinite(d)) {
      if (r.base === 'ml' && item.baseUnit === 'g') return qty * r.factor * d;
      if (r.base === 'g' && item.baseUnit === 'ml') return (qty * r.factor) / d;
    }
    throw new Error('تحويل غير متوافق بين الوزن والحجم والعدد — عرّف كثافة الخامة إن لزم');
  }

  function compatibleUnits(itemOrBase, keep) {
    const item = typeof itemOrBase === 'string' ? { baseUnit: itemOrBase } : itemOrBase;
    return Object.keys(UOM).filter((id) => {
      if (!UOM[id].active && id !== keep) return false;
      try { toBase(1, id, item); return true; } catch (e) { return false; }
    });
  }

  function validateConvs(item) {
    for (const [id, cv] of Object.entries(item.convs || {})) {
      const u = UOM[id];
      if (!u) return `وحدة غير معروفة: ${id}`;
      if (TYPE_BASE[u.type]) return `«${u.name}» وحدة ثابتة ولا تُعرَّف لكل خامة`;
      if (!(typeof cv.qty === 'number' && Number.isFinite(cv.qty) && cv.qty > 0)) return `معامل تحويل «${u.name}» يجب أن يكون رقمًا موجبًا`;
      if (cv.of === id) return `«${u.name}» لا يمكن تعريفها بنفسها`;
      try { toBase(1, id, item); } catch (e) { return `«${u.name}»: ${e.message}`; }
    }
    return '';
  }

  function decimalsOk(qty, unitId) {
    const u = UOM[unitId];
    const m = Math.pow(10, u ? u.decimals : 3);
    return Number.isFinite(qty) && Math.abs(qty * m - Math.round(qty * m)) < 1e-7;
  }

  function recipeCost(ingredients) {
    let exact = 0;
    const lines = ingredients.map((i) => {
      const baseQty = toBase(i.qty, i.unit, i.item || i.base);
      const sub = baseQty * i.costPerBase;
      exact += sub;
      return { ...i, baseQty, subtotal: Math.round(sub) };
    });
    return { lines, cost: Math.round(exact) };
  }

  /** Margin against the ex-tax list price (discounts are not included). */
  function recipeMargin(p, tax) {
    const net = priceExTax(p.price, p.taxExempt, tax);
    const cost = p.ingredientCost + (p.extraCost ?? 0);
    const profit = net - cost;
    const marginPct = net > 0 ? Math.round((profit / net) * 10000) / 100 : 0;
    return { netPrice: net, cost, profit, marginPct };
  }

// ===== lib: format =====
  /** Formatting helpers (Arabic / Egypt). Money is integer piastres. */

  const nf = new Intl.NumberFormat('ar-EG-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfInt = new Intl.NumberFormat('ar-EG-u-nu-latn');

  /** 12345 → "١٢٣٫٤٥" (no currency). */
  function fmtNum(piastres) {
    return nf.format(piastres / 100);
  }

  /** 12345 → "١٢٣٫٤٥ ج.م" */
  function fmtMoney(piastres) {
    return `${nf.format(piastres / 100)} ج.م`;
  }

  function fmtInt(n) {
    return nfInt.format(n);
  }

  function fmtQty(n) {
    return new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 2 }).format(n);
  }

  function fmtPct(n) {
    return `${new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 2 }).format(n)}٪`;
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function fmtDate(iso, fmt = 'dd/MM/yyyy') {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const s =
      fmt === 'dd/MM/yyyy'
        ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
        : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return s;
  }

  function fmtTime(iso, hour12 = true) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12 });
  }

  function fmtDateTime(iso, fmt = 'dd/MM/yyyy', hour12 = true) {
    return `${fmtDate(iso, fmt)} ${fmtTime(iso, hour12)}`;
  }

  /** Local YYYY-MM-DD key for grouping. */
  function dayKey(iso) {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function minutesSince(iso, now = Date.now()) {
    return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  }

  /** "١:٢٥" style elapsed label. */
  function fmtElapsed(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${new Intl.NumberFormat('ar-EG-u-nu-latn', { minimumIntegerDigits: 2 }).format(h)}:${new Intl.NumberFormat('ar-EG-u-nu-latn', { minimumIntegerDigits: 2 }).format(m)}`;
  }

  /** Parse a user-typed EGP amount ("12.5" / "١٢٫٥") into integer piastres. Returns NaN if invalid. */
  function parseEgp(input) {
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const norm = input
      .replace(/[٠-٩]/g, (c) => String(ar.indexOf(c)))
      .replace(/[٫,]/g, '.')
      .trim();
    if (norm === '' || !/^\d*\.?\d{0,2}$/.test(norm) || norm === '.') return Number.NaN;
    return Math.round(parseFloat(norm) * 100);
  }

  /** Integer piastres → plain editable string "12.5". */
  function egpToInput(piastres) {
    return piastres % 100 === 0 ? String(piastres / 100) : (piastres / 100).toFixed(2);
  }

  let seq = 0;
  function uid(prefix = 'id') {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

// ===== lib: csv =====
  /** Demo CSV export (UTF-8 with BOM so Excel opens Arabic correctly). */
  function toCsv(rows) {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  function downloadFile(filename, content, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob(mime.indexOf('text/csv') === 0 ? ['\uFEFF', content] : [content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(filename, rows) {
    downloadFile(filename, toCsv(rows));
  }

// ===== lib: calc =====
  /** Cart / order pricing helpers shared by the cashier, the seed generator and the store. */

  function taxConfigOf(s) {
    return {
      enabled: s.tax.enabled,
      rateBps: Math.round(s.tax.ratePct * 100),
      mode: s.tax.mode,
      rounding: s.tax.rounding,
    };
  }

  function cartUnitPrice(i) {
    return Math.max(0, i.basePrice + i.options.reduce((s, o) => s + o.price, 0));
  }

  function priceCart(items, discount, settings) {
    const lines = items.map((i) => ({ unitPrice: cartUnitPrice(i), qty: i.qty, taxExempt: i.taxExempt }));
    return calcTotals(lines, discount, taxConfigOf(settings));
  }

  /** Current ingredient cost (+ extra direct cost) for ONE serving of a product. */
  function productUnitCost(product, recipes, inventory) {
    const lines = recipes[product.id] ?? [];
    const ing = recipeCost(
      lines.flatMap((l) => {
        const it = inventory.find((x) => x.id === l.inventoryId);
        return it ? [{ qty: l.qty, unit: l.unit, costPerBase: it.costPerBase, base: it.baseUnit, item: it }] : [];
      }),
    ).cost;
    return { ingredients: ing, extra: product.extraCost, total: ing + product.extraCost };
  }

  /** Ingredient requirements (in base units) for a set of order items. */
  function requirementsFor(items, recipes, inventory) {
    const need = new Map();
    for (const it of items) {
      for (const l of recipes[it.productId] ?? []) {
        const inv = inventory.find((x) => x.id === l.inventoryId);
        if (!inv) continue;
        need.set(l.inventoryId, (need.get(l.inventoryId) ?? 0) + toBase(l.qty, l.unit, inv) * it.qty);
      }
    }
    return need;
  }

  function toOrderItems(cart, totals, costOf, prev = []) {
    return cart.map((c, i) => {
      const l = totals.lines[i];
      const old = prev.find((p) => p.key === c.key);
      return {
        ...c,
        unitPrice: cartUnitPrice(c),
        lineTotal: l.lineTotal,
        discountAlloc: l.discountAlloc,
        taxAlloc: l.taxAlloc,
        netAlloc: l.netAlloc,
        totalAlloc: l.totalAlloc,
        unitCost: costOf(c.productId, c),
        refundedQty: old?.refundedQty ?? 0,
        refundedAmount: old?.refundedAmount ?? 0,
        kitchenQty: Math.min(old?.kitchenQty ?? 0, c.qty),
      };
    });
  }

  function refundState(o) {
    if (o.status !== 'completed') return 'none';
    const sold = o.items.reduce((s, i) => s + i.qty, 0);
    const ref = o.items.reduce((s, i) => s + i.refundedQty, 0);
    if (ref === 0) return 'none';
    return ref >= sold ? 'full' : 'partial';
  }

// ===== lib: permissions =====
  /** Permission catalog for the UI-only role simulation. Real enforcement must live in the future backend. */
  const NAV_PERMS = [
    { key: 'page.dashboard', label: 'الرئيسية', group: 'الشاشات' },
    { key: 'page.cashier', label: 'الكاشير', group: 'الشاشات' },
    { key: 'page.tables', label: 'الطاولات', group: 'الشاشات' },
    { key: 'page.orders', label: 'الطلبات', group: 'الشاشات' },
    { key: 'page.products', label: 'الأصناف', group: 'الشاشات' },
    { key: 'page.categories', label: 'التصنيفات', group: 'الشاشات' },
    { key: 'page.recipes', label: 'الوصفات والتكلفة', group: 'الشاشات' },
    { key: 'page.inventory', label: 'المخزون', group: 'الشاشات' },
    { key: 'page.purchases', label: 'المشتريات', group: 'الشاشات' },
    { key: 'page.suppliers', label: 'الموردون', group: 'الشاشات' },
    { key: 'page.expenses', label: 'المصروفات', group: 'الشاشات' },
    { key: 'page.customers', label: 'العملاء', group: 'الشاشات' },
    { key: 'page.users', label: 'المستخدمون والصلاحيات', group: 'الشاشات' },
    { key: 'page.reports', label: 'التقارير', group: 'الشاشات' },
    { key: 'page.cashbox', label: 'الخزنة والورديات', group: 'الشاشات' },
    { key: 'page.refunds', label: 'المرتجعات', group: 'الشاشات' },
    { key: 'page.attendance', label: 'الحضور والغياب', group: 'الشاشات' },
    { key: 'page.printers', label: 'إعدادات الطابعات', group: 'الشاشات' },
    { key: 'page.settings', label: 'الإعدادات', group: 'الشاشات' },
    { key: 'page.backup', label: 'النسخ الاحتياطي والاستعادة', group: 'الشاشات' },
  ];

  const ACTION_PERMS = [
    { key: 'refunds.execute', label: 'تنفيذ المرتجعات', group: 'العمليات الحساسة' },
    { key: 'discount.apply', label: 'تطبيق خصم على الفاتورة', group: 'العمليات الحساسة' },
    { key: 'discount.approve', label: 'اعتماد الخصومات المقيدة', group: 'العمليات الحساسة' },
    { key: 'catalog.edit', label: 'تعديل الأصناف والتصنيفات', group: 'العمليات الحساسة' },
    { key: 'inventory.adjust', label: 'تعديل المخزون', group: 'العمليات الحساسة' },
    { key: 'settings.edit', label: 'تعديل الإعدادات', group: 'العمليات الحساسة' },
    { key: 'orders.cancel', label: 'إلغاء أو تقليل طلب أُرسل للمطبخ', group: 'العمليات الحساسة' },
    { key: 'attendance.manage', label: 'إدارة الحضور والغياب', group: 'العمليات الحساسة' },
  ];

  const ALL_PERMS = [...NAV_PERMS, ...ACTION_PERMS];

  function hasPerm(perms, key) {
    if (!perms) return false;
    return perms.includes('*') || perms.includes(key);
  }

// ===== lib: catalog (demo menu) =====
// ===== منيو ميروفا الجديد (يستبدل كل الأصناف والأقسام القديمة) =====
const MIROVA_MENU = {
  categories: [{"id": "c_hot", "name": "المشروبات الساخنة", "icon": "☕", "sortOrder": 1, "active": true}, {"id": "c_tea", "name": "الشاي والأعشاب والسحلب", "icon": "🍵", "sortOrder": 2, "active": true}, {"id": "c_cold", "name": "القهوة المثلجة", "icon": "🧊", "sortOrder": 3, "active": true}, {"id": "c_frappe", "name": "الفرابيه", "icon": "🥤", "sortOrder": 4, "active": true}, {"id": "c_matcha", "name": "الماتشا", "icon": "🍵", "sortOrder": 5, "active": true}, {"id": "c_dessert", "name": "الحلويات", "icon": "🍰", "sortOrder": 6, "active": true}, {"id": "c_waffle", "name": "الوافل والبان كيك", "icon": "🧇", "sortOrder": 7, "active": true}, {"id": "c_sundae", "name": "الصنداي", "icon": "🍨", "sortOrder": 8, "active": true}, {"id": "c_shake", "name": "الميلك شيك", "icon": "🥛", "sortOrder": 9, "active": true}, {"id": "c_candy", "name": "كاندي شيك", "icon": "🍫", "sortOrder": 10, "active": true}, {"id": "c_smoothie", "name": "السموذي", "icon": "🥤", "sortOrder": 11, "active": true}, {"id": "c_yogurt", "name": "الزبادي الخلاط", "icon": "🥛", "sortOrder": 12, "active": true}, {"id": "c_juice", "name": "العصائر الطازجة", "icon": "🍹", "sortOrder": 13, "active": true}, {"id": "c_fruits", "name": "الفواكه الموسمية", "icon": "🍑", "sortOrder": 14, "active": true}, {"id": "c_cocktail", "name": "فريش كوكتيل", "icon": "🍹", "sortOrder": 15, "active": true}, {"id": "c_soda", "name": "كوكتيل صودا", "icon": "🧊", "sortOrder": 16, "active": true}, {"id": "c_soft", "name": "المشروبات الغازية", "icon": "🥫", "sortOrder": 17, "active": true}, {"id": "c_kids", "name": "منيو الأطفال", "icon": "🧒", "sortOrder": 18, "active": true}],
  rows: [["c_hot", "Turkish Coffee Single — قهوة تركي سينجل", 37, "☕"], ["c_hot", "Turkish Coffee Double — قهوة تركي دبل", 52, "☕"], ["c_hot", "Flavored Turkish Coffee — قهوة تركي نكهات", 45, "☕"], ["c_hot", "Espresso Single — اسبريسو سينجل", 46, "☕"], ["c_hot", "Espresso Double — اسبريسو دبل", 58, "☕"], ["c_hot", "Macchiato Single — ميكاتو سينجل", 50, "☕"], ["c_hot", "Macchiato Double — ميكاتو دبل", 69, "☕"], ["c_hot", "Cortado Single — كرتادو سينجل", 45, "☕"], ["c_hot", "Cortado Double — كرتادو دبل", 68, "☕"], ["c_hot", "Espresso Con Panna Single — اسبريسو كون بانا سينجل", 53, "☕"], ["c_hot", "Espresso Con Panna Double — اسبريسو كون بانا دبل", 67, "☕"], ["c_hot", "Americano Coffee — أمريكانو كوفي", 65, "☕"], ["c_hot", "French Coffee Single — قهوة فرنساوي سينجل", 42, "☕"], ["c_hot", "French Coffee Double — قهوة فرنساوي دبل", 50, "☕"], ["c_hot", "Hazelnut Coffee Single — قهوة بندق سنجل", 47, "☕"], ["c_hot", "Hazelnut Coffee Double — قهوة بندق دبل", 55, "☕"], ["c_hot", "Nutella Coffee Double — قهوة نوتيلا دبل", 70, "☕"], ["c_hot", "V60", 85, "☕"], ["c_hot", "Flat White", 65, "☕"], ["c_hot", "Latte", 75, "☕"], ["c_hot", "Spanish Latte", 85, "☕"], ["c_hot", "Hot Moka (Dark/White)", 87, "☕"], ["c_hot", "Latte Caramel", 95, "☕"], ["c_hot", "Nescafé", 65, "☕"], ["c_hot", "Cabitchino", 77, "☕"], ["c_tea", "Tea", 27, "🍵"], ["c_tea", "Tea Flavor", 35, "🍵"], ["c_tea", "Milk Tea — شاي حليب", 45, "🍵"], ["c_tea", "Karak Tea — شاي كرك", 45, "🍵"], ["c_tea", "Herbal Tea — أعشاب", 35, "🍵"], ["c_tea", "Herbal Mix — ميكس أعشاب", 79, "🍵"], ["c_tea", "Cinnamon Milk — قرفة حليب", 50, "🍵"], ["c_tea", "Tea Kettle — براد شاي", 60, "🍵"], ["c_tea", "Green Tea", 30, "🍵"], ["c_tea", "Hot Cedar", 50, "🍵"], ["c_tea", "Hot Chocolate", 80, "🍵"], ["c_tea", "Hot Lotus", 80, "🍵"], ["c_tea", "Hot Oreo", 90, "🍵"], ["c_tea", "Sahlab — سحلب", 85, "🍵"], ["c_tea", "Sahlab Fruits — سحلب فواكه", 105, "🍵"], ["c_tea", "Sahlab Nuts — سحلب مكسرات", 95, "🍵"], ["c_cold", "Ice Latte", 70, "🧊"], ["c_cold", "Ice Spanish Latte", 95, "🧊"], ["c_cold", "Ice Moka", 90, "🧊"], ["c_cold", "Ice Cabitchino", 80, "🧊"], ["c_cold", "Ice Nescafé", 65, "🧊"], ["c_cold", "Ice Amrecano", 55, "🧊"], ["c_cold", "Ice Caramel Mekato", 95, "🧊"], ["c_cold", "Ice Matcha", 95, "🧊"], ["c_cold", "Ice Mirova Matcha", 115, "🧊"], ["c_cold", "Ice Matcha Strawberry", 110, "🧊"], ["c_frappe", "Ice Frappe Vanilla", 80, "🥤"], ["c_frappe", "Ice Frappe Chocolate", 85, "🥤"], ["c_frappe", "Ice Frappe Caramel", 90, "🥤"], ["c_frappe", "Ice Frappe Lotus", 100, "🥤"], ["c_frappe", "Ice Frappe Pistachio", 105, "🥤"], ["c_frappe", "Ice Frappe Oreo", 95, "🥤"], ["c_frappe", "Iced Toffee Frappe", 95, "🥤"], ["c_matcha", "Strawberry Matcha — ماتشا فراولة", 115, "🍵"], ["c_matcha", "Matcha Frappe — ماتشا فرابيه", 120, "🍵"], ["c_matcha", "Blueberry Matcha — بلوبيري ماتشا", 115, "🍵"], ["c_matcha", "Mirova Matcha — ميروڤا ماتشا", 125, "🍵"], ["c_matcha", "Iced Matcha Latte — لاتيه ماتشا آيس", 95, "🍵"], ["c_matcha", "Hot Matcha — هوت ماتشا", 75, "🍵"], ["c_dessert", "Classic Molten — مولتن كلاسيك", 135, "🍰"], ["c_dessert", "Nutella Molten — مولتن نوتيلا", 137, "🍰"], ["c_dessert", "Round Cheesecake — تشيز كيك راوند", 110, "🍰"], ["c_dessert", "San Sebastian Cheesecake — سان سباستيان", 115, "🍰"], ["c_dessert", "Chocolate Lovers — شوكليت لافرز", 125, "🍰"], ["c_dessert", "Oreo Chocolate — شوكليت أوريو", 135, "🍰"], ["c_dessert", "Bronze Cake — برونز كيك", 100, "🍰"], ["c_dessert", "Fudge Cake — ڤادج", 105, "🍰"], ["c_dessert", "Tiramisu — تيراميسو", 105, "🍰"], ["c_waffle", "Waffle with Sauce — وافل بالصوص", 110, "🧇"], ["c_waffle", "Waffle with Premium Sauce — وافل صوص", 125, "🧇"], ["c_waffle", "Fruit Waffle — وافل فروت", 120, "🧇"], ["c_waffle", "Mini Pancakes 12 Pieces — ميني بان كيك", 80, "🧇"], ["c_waffle", "Mini Pancakes 24 Pieces — ميني بان كيك", 140, "🧇"], ["c_waffle", "Waffle Sticks — وافل ستيك", 70, "🧇"], ["c_waffle", "Banana Waffle — وافل موز", 105, "🧇"], ["c_sundae", "Mix Ice Cream – 3 Scoops", 90, "🍨"], ["c_sundae", "Oreo Sundae", 115, "🍨"], ["c_sundae", "KitKat Sundae", 125, "🍨"], ["c_sundae", "Maltesers Sundae", 120, "🍨"], ["c_sundae", "Brownies Sundae", 135, "🍨"], ["c_sundae", "Cheesecake Sundae", 140, "🍨"], ["c_sundae", "Red Velvet Sundae", 115, "🍨"], ["c_shake", "Chocolate Milkshake", 80, "🥛"], ["c_shake", "Vanilla Milkshake", 75, "🥛"], ["c_shake", "Strawberry Milkshake", 80, "🥛"], ["c_shake", "Mango Milkshake", 80, "🥛"], ["c_shake", "Banana Milkshake", 95, "🥛"], ["c_shake", "Blueberry Milkshake", 95, "🥛"], ["c_shake", "Kiwi Milkshake", 95, "🥛"], ["c_shake", "Lotus Milkshake", 100, "🥛"], ["c_shake", "Caramel Milkshake", 95, "🥛"], ["c_shake", "Dubai Milkshake", 105, "🥛"], ["c_shake", "Almond Cream Milkshake", 105, "🥛"], ["c_shake", "Hazelnut Milkshake", 105, "🥛"], ["c_candy", "Oreo Candy Shake", 90, "🍫"], ["c_candy", "KitKat Candy Shake", 105, "🍫"], ["c_candy", "Maltesers Candy Shake", 105, "🍫"], ["c_candy", "Twix Candy Shake", 110, "🍫"], ["c_candy", "Snickers Candy Shake", 110, "🍫"], ["c_candy", "Kinder Candy Shake", 116, "🍫"], ["c_candy", "Cheesecake Candy Shake", 120, "🍫"], ["c_candy", "Brownie Candy Shake", 120, "🍫"], ["c_candy", "Red Velvet Candy Shake", 110, "🍫"], ["c_smoothie", "Smoothie Lemon Mint", 50, "🥤"], ["c_smoothie", "Smoothie Peach", 95, "🥤"], ["c_smoothie", "Smoothie Passion Fruit", 95, "🥤"], ["c_smoothie", "Smoothie Blueberry", 95, "🥤"], ["c_smoothie", "Smoothie Green Apple", 90, "🥤"], ["c_smoothie", "Smoothie Colada", 110, "🥤"], ["c_smoothie", "Smoothie Watermelon", 65, "🥤"], ["c_smoothie", "Smoothie Mango", 90, "🥤"], ["c_smoothie", "Smoothie Strawberry", 85, "🥤"], ["c_smoothie", "Smoothie Kiwi", 110, "🥤"], ["c_smoothie", "Smoothie Red Berry", 90, "🥤"], ["c_smoothie", "Smoothie Pineapple", 95, "🥤"], ["c_smoothie", "Smoothie Mixed Berry", 110, "🥤"], ["c_smoothie", "Smoothie Mango Kiwi", 115, "🥤"], ["c_smoothie", "Smoothie Vimto", 95, "🥤"], ["c_yogurt", "Strawberry Yogurt — زبادي فراولة", 77, "🥛"], ["c_yogurt", "Berry Yogurt — زبادي بيري", 77, "🥛"], ["c_yogurt", "Peach Yogurt — زبادي خوخ", 75, "🥛"], ["c_yogurt", "Mango Yogurt — زبادي مانجا", 80, "🥛"], ["c_yogurt", "Passion Fruit Yogurt — زبادي باشن فروت", 75, "🥛"], ["c_yogurt", "Mixed Fruit Yogurt — زبادي مكس فروت", 85, "🥛"], ["c_juice", "Lemon Juice", 45, "🍹"], ["c_juice", "Lemon Mint Juice", 50, "🍹"], ["c_juice", "Orange Juice", 65, "🍹"], ["c_juice", "Mango Juice", 80, "🍹"], ["c_juice", "Strawberry Juice", 80, "🍹"], ["c_juice", "Guava Juice", 75, "🍹"], ["c_juice", "Panana Juice", 75, "🍹"], ["c_fruits", "Peach (Fruit)", 75, "🍑"], ["c_fruits", "Water Melon (Fruit)", 70, "🍑"], ["c_fruits", "Plum (Fruit)", 85, "🍑"], ["c_fruits", "Cantalob/Honey Melon (Fruit)", 75, "🍑"], ["c_fruits", "Pomegranate — رمان (Fruit)", 75, "🍑"], ["c_fruits", "Avocado (Fruit)", 140, "🍑"], ["c_fruits", "Kiwi (Fruit)", 120, "🍑"], ["c_cocktail", "Florida — فلوريدا", 85, "🍹"], ["c_cocktail", "Hawaii — هاواي", 85, "🍹"], ["c_cocktail", "Organic — اورجانيك", 80, "🍹"], ["c_cocktail", "Mirova Power — مروڤا بور", 150, "🍹"], ["c_cocktail", "Mango Kiwi — مانجو كيوي", 110, "🍹"], ["c_cocktail", "Slushie Cocktail — سلاشير كوكتيل", 85, "🍹"], ["c_cocktail", "Crazy Lemon — كريزي لمون", 90, "🍹"], ["c_cocktail", "Guava Mint — جوافه نعناع", 80, "🍹"], ["c_cocktail", "Strawberry Mint — فراوله نعناع", 80, "🍹"], ["c_cocktail", "Pina Colada — بينا كولادا", 85, "🍹"], ["c_soda", "Blue Mojito — بلو موخيتو", 70, "🧊"], ["c_soda", "Blue Hawaii — بلو هاواي", 70, "🧊"], ["c_soda", "Scotch Mint — سكوتش مينت", 70, "🧊"], ["c_soda", "Electric Blue — إلكتريك بلو", 90, "🧊"], ["c_soda", "Tropical — تروبيكال", 70, "🧊"], ["c_soda", "Sunshine Strawberry — صن شاين فراولة", 75, "🧊"], ["c_soda", "Atlas Black — أطلس بلاك", 80, "🧊"], ["c_soda", "Cherry Cola — شيري كولا", 65, "🧊"], ["c_soda", "Blackberry Soda — بلاك بيري صودا", 75, "🧊"], ["c_soda", "Morova Blue — مروڤا بلو", 135, "🧊"], ["c_soda", "Bullfrog — بول فروج", 140, "🧊"], ["c_soft", "Pepsi", 40, "🥫"], ["c_soft", "Seven", 40, "🥫"], ["c_soft", "Shewips", 47, "🥫"], ["c_soft", "Peril", 49, "🥫"], ["c_soft", "Fewory", 47, "🥫"], ["c_soft", "Fanta", 40, "🥫"], ["c_soft", "Redbull", 90, "🥫"], ["c_soft", "Water", 12, "🥫"], ["c_kids", "Oreao Kids (4 Mini Pancake + Oreo Milkshake)", 145, "🧒"], ["c_kids", "Steak Fun (Waffle Steak + Juice Fresh)", 140, "🧒"], ["c_kids", "Chees Fun (Cheesecake + Juice Fresh)", 155, "🧒"], ["c_kids", "Mini Fruit Dish Slices", 100, "🧒"], ["c_kids", "Sweet Sundae (6 Pancake + 1 Scoop Ice Cream)", 105, "🧒"], ["c_kids", "Oreo Kids (Dessert Oreo + Oreo Milkshake)", 165, "🧒"], ["c_kids", "Mango Fun (4 Pancakes + Mango Juice)", 140, "🧒"]],
  products() {
    return this.rows.map(([categoryId, name, price, emoji], i) => ({
      id: `m${String(i + 1).padStart(3, '0')}`, name, categoryId,
      sku: `HOP-M${String(i + 1).padStart(4, '0')}`,
      price: price * 100, emoji, tone: i % 8, stockMode: 'none', active: true, taxExempt: false, modifierGroupIds: [], extraCost: 0,
    }));
  },
};

const SEED = (() => {
  /** Demo catalog: categories, modifier groups, products, ingredients and recipes. DEMO DATA ONLY. */

  const categories = [
    { id: 'c_hot', name: 'المشروبات الساخنة', icon: '☕', sortOrder: 1, active: true },
    { id: 'c_cold', name: 'القهوة المثلجة', icon: '🧊', sortOrder: 2, active: true },
    { id: 'c_tea', name: 'الشاي والمشروبات الدافئة', icon: '🍵', sortOrder: 3, active: true },
    { id: 'c_fresh', name: 'الموهيتو والعصائر', icon: '🍹', sortOrder: 4, active: true },
    { id: 'c_shake', name: 'السموذي والميلك شيك', icon: '🥤', sortOrder: 5, active: true },
    { id: 'c_waffle', name: 'الوافل والبان كيك', icon: '🧇', sortOrder: 6, active: true },
    { id: 'c_dessert', name: 'الحلويات', icon: '🍰', sortOrder: 7, active: true },
    { id: 'c_sand', name: 'الساندويتشات', icon: '🥪', sortOrder: 8, active: true },
    { id: 'c_burger', name: 'البرجر', icon: '🍔', sortOrder: 9, active: true },
    { id: 'c_matcha', name: 'الماتشا', icon: '🍵', sortOrder: 10, active: true },
    { id: 'c_sundae', name: 'الصنداي', icon: '🍨', sortOrder: 11, active: true },
    { id: 'c_candy', name: 'كاندي شيك', icon: '🍫', sortOrder: 12, active: true },
    { id: 'c_smoothie', name: 'السموذي', icon: '🥤', sortOrder: 13, active: true },
    { id: 'c_yogurt', name: 'الزبادي المخفوق', icon: '🥛', sortOrder: 14, active: true },
    { id: 'c_fruits', name: 'الفواكه الموسمية', icon: '🍑', sortOrder: 15, active: true },
    { id: 'c_cocktail', name: 'فريش كوكتيل', icon: '🍹', sortOrder: 16, active: true },
    { id: 'c_soda', name: 'سودا كوكتيل', icon: '🧊', sortOrder: 17, active: true },
    { id: 'c_soft', name: 'المشروبات الغازية', icon: '🥫', sortOrder: 18, active: true },
    { id: 'c_kids', name: 'منيو الأطفال', icon: '🧒', sortOrder: 19, active: true },
  ];

  const o = (id, name, price = 0, isDefault = false) => ({ id, name, price, isDefault });

  const modifierGroups = [
    {
      id: 'g_size',
      name: 'الحجم',
      required: true,
      multi: false,
      options: [o('s', 'صغير', -2000), o('m', 'متوسط', 0, true), o('l', 'كبير', 2000)],
    },
    {
      id: 'g_temp',
      name: 'نوع التحضير',
      required: true,
      multi: false,
      options: [o('hot', 'ساخن', 0, true), o('iced', 'بارد', 0)],
    },
    {
      id: 'g_strength',
      name: 'قوة القهوة',
      required: true,
      multi: false,
      options: [o('plain', 'سادة', 0, true), o('light', 'فاتح'), o('dark', 'غامق')],
    },
    {
      id: 'g_sugar',
      name: 'السكر',
      required: true,
      multi: false,
      options: [o('none', 'بدون سكر'), o('low', 'سكر خفيف'), o('reg', 'مظبوط', 0, true), o('extra', 'سكر زيادة')],
    },
    {
      id: 'g_milk',
      name: 'نوع اللبن',
      required: true,
      multi: false,
      options: [o('reg', 'عادي', 0, true), o('skim', 'خالي الدسم'), o('almond', 'لوز', 1500), o('oat', 'شوفان', 1500)],
    },
    {
      id: 'g_coffee_extra',
      name: 'إضافات',
      required: false,
      multi: true,
      options: [
        o('caramel', 'كراميل', 1000),
        o('vanilla', 'فانيليا', 1500),
        o('choco', 'شوكولاتة', 1500),
        o('cream', 'كريمة', 1500),
        o('shot', 'شوت إسبريسو', 2000),
      ],
    },
    {
      id: 'g_tea_extra',
      name: 'إضافات',
      required: false,
      multi: true,
      options: [o('mint', 'نعناع'), o('lemon', 'ليمون'), o('ginger', 'زنجبيل', 500)],
    },
    {
      id: 'g_shake_size',
      name: 'الحجم',
      required: true,
      multi: false,
      options: [o('m', 'عادي', 0, true), o('l', 'كبير', 2500)],
    },
    {
      id: 'g_waffle_top',
      name: 'الإضافات',
      required: false,
      multi: true,
      options: [
        o('choco', 'شوكولاتة', 1500),
        o('icecream', 'آيس كريم', 2500),
        o('fruit', 'فواكه', 2000),
        o('nutella', 'نوتيلا', 2000),
      ],
    },
    {
      id: 'g_sand_extra',
      name: 'إضافات',
      required: false,
      multi: true,
      options: [o('cheese', 'جبنة إضافية', 1000), o('fries', 'بطاطس', 1500), o('nopickle', 'بدون مخلل')],
    },
    {
      id: 'g_burger_extra',
      name: 'إضافات',
      required: false,
      multi: true,
      options: [
        o('cheese', 'جبنة شيدر', 1000),
        o('egg', 'بيضة', 1000),
        o('bacon', 'لحم مقدد', 2500),
        o('fries', 'بطاطس', 1500),
      ],
    },
  ];

  // [name, category, price EGP, emoji, modifier groups, extraCost piastres]
  const HOT = ['g_size', 'g_temp', 'g_strength', 'g_sugar', 'g_milk', 'g_coffee_extra'];
  const raw = [
    ['إسبريسو', 'c_hot', 45, '☕', ['g_sugar', 'g_coffee_extra'], 100],
    ['أمريكانو', 'c_hot', 65, '☕', ['g_size', 'g_strength', 'g_sugar', 'g_coffee_extra'], 100],
    ['كابتشينو', 'c_hot', 80, '☕', HOT, 100],
    ['لاتيه', 'c_hot', 75, '🥛', HOT, 100],
    ['موكا', 'c_hot', 90, '🍫', HOT, 100],
    ['كراميل ماكياتو', 'c_hot', 90, '🍯', HOT, 100],
    ['قهوة تركية', 'c_hot', 40, '🫖', ['g_sugar'], 80],
    ['هوت شوكليت', 'c_hot', 80, '🍫', ['g_size', 'g_milk', 'g_coffee_extra'], 100],
    ['آيس لاتيه', 'c_cold', 90, '🧊', HOT, 120],
    ['آيس موكا', 'c_cold', 95, '🧋', HOT, 120],
    ['آيس كراميل ماكياتو', 'c_cold', 95, '🍯', HOT, 120],
    ['آيس بستاشيو لاتيه', 'c_cold', 125, '🥜', HOT, 120],
    ['آيس أمريكانو', 'c_cold', 55, '🧊', ['g_size', 'g_strength', 'g_sugar', 'g_coffee_extra'], 120],
    ['فرابيه كراميل', 'c_cold', 90, '🥤', HOT, 120],
    ['شاي', 'c_tea', 30, '🍵', ['g_sugar', 'g_tea_extra'], 60],
    ['شاي بالنعناع', 'c_tea', 40, '🌿', ['g_sugar', 'g_tea_extra'], 60],
    ['سحلب', 'c_tea', 85, '🥣', ['g_sugar'], 80],
    ['ينسون', 'c_tea', 35, '🍃', ['g_sugar'], 60],
    ['موهيتو', 'c_fresh', 80, '🍹', [], 100],
    ['موهيتو فراولة', 'c_fresh', 90, '🍓', [], 100],
    ['عصير برتقال', 'c_fresh', 65, '🍊', [], 100],
    ['ليمون بالنعناع', 'c_fresh', 55, '🍋', [], 100],
    ['عصير مانجو', 'c_fresh', 80, '🥭', [], 100],
    ['عصير فراولة', 'c_fresh', 80, '🍓', [], 100],
    ['سموذي مانجو', 'c_shake', 90, '🥭', ['g_shake_size'], 100],
    ['سموذي فراولة', 'c_shake', 90, '🍓', ['g_shake_size'], 100],
    ['ميلك شيك شوكولاتة', 'c_shake', 80, '🍫', ['g_shake_size'], 100],
    ['ميلك شيك فانيليا', 'c_shake', 75, '🍦', ['g_shake_size'], 100],
    ['ميلك شيك أوريو', 'c_shake', 95, '🍪', ['g_shake_size'], 100],
    ['وافل', 'c_waffle', 110, '🧇', ['g_waffle_top'], 150],
    ['بان كيك', 'c_waffle', 100, '🥞', ['g_waffle_top'], 150],
    ['وافل نوتيلا', 'c_waffle', 135, '🧇', ['g_waffle_top'], 150],
    ['بان كيك فواكه', 'c_waffle', 110, '🥞', ['g_waffle_top'], 150],
    ['تشيز كيك', 'c_dessert', 110, '🍰', [], 0],
    ['براونيز', 'c_dessert', 70, '🍫', [], 0],
    ['كرواسون شوكولاتة', 'c_dessert', 55, '🥐', [], 0],
    ['ميني دونتس', 'c_dessert', 60, '🍩', [], 0],
    ['كوكيز', 'c_dessert', 35, '🍪', [], 0],
    ['ساندويتش جبنة رومي', 'c_sand', 60, '🥪', ['g_sand_extra'], 100],
    ['كلوب ساندويتش', 'c_sand', 95, '🥪', ['g_sand_extra'], 100],
    ['شاورما فراخ', 'c_sand', 85, '🌯', ['g_sand_extra'], 100],
    ['تشيكن راب', 'c_sand', 90, '🌯', ['g_sand_extra'], 100],
    ['برجر كلاسيك', 'c_burger', 130, '🍔', ['g_burger_extra'], 150],
    ['تشيز برجر', 'c_burger', 145, '🍔', ['g_burger_extra'], 150],
    ['دبل برجر', 'c_burger', 180, '🍔', ['g_burger_extra'], 150],
    ['تشيكن برجر', 'c_burger', 120, '🍗', ['g_burger_extra'], 150],
    // ===== منيو ميروفا (أصناف بدون وصفات — لا تخصم من المخزون) =====
    ['قهوة تركي سنجل', 'c_hot', 40, '☕', [], 0, 'none'],
    ['قهوة تركي دبل', 'c_hot', 50, '☕', [], 0, 'none'],
    ['قهوة تركي بنكهة', 'c_hot', 45, '☕', [], 0, 'none'],
    ['إسبريسو دبل', 'c_hot', 60, '☕', [], 0, 'none'],
    ['كورتادو سنجل', 'c_hot', 45, '☕', [], 0, 'none'],
    ['كورتادو دبل', 'c_hot', 70, '☕', [], 0, 'none'],
    ['ماكياتو سنجل', 'c_hot', 55, '☕', [], 0, 'none'],
    ['ماكياتو دبل', 'c_hot', 70, '☕', [], 0, 'none'],
    ['قهوة بنكهة', 'c_hot', 45, '☕', [], 0, 'none'],
    ['قهوة فرنسي سنجل', 'c_hot', 45, '☕', [], 0, 'none'],
    ['قهوة فرنسي دبل', 'c_hot', 50, '☕', [], 0, 'none'],
    ['قهوة بندق سنجل', 'c_hot', 50, '☕', [], 0, 'none'],
    ['قهوة بندق دبل', 'c_hot', 55, '☕', [], 0, 'none'],
    ['قهوة نوتيلا دبل', 'c_hot', 70, '☕', [], 0, 'none'],
    ['فلات وايت', 'c_hot', 65, '☕', [], 0, 'none'],
    ['كراميل لاتيه', 'c_hot', 95, '☕', [], 0, 'none'],
    ['سبانش لاتيه', 'c_hot', 85, '☕', [], 0, 'none'],
    ['شاي أخضر', 'c_tea', 30, '🍵', [], 0, 'none'],
    ['شاي بنكهة', 'c_tea', 35, '🍵', [], 0, 'none'],
    ['شاي بالحليب', 'c_tea', 45, '🍵', [], 0, 'none'],
    ['شاي كرك', 'c_tea', 45, '🍵', [], 0, 'none'],
    ['لبن بالقرفة', 'c_tea', 50, '🍵', [], 0, 'none'],
    ['براد شاي', 'c_tea', 60, '🍵', [], 0, 'none'],
    ['سيدر ساخن', 'c_tea', 50, '🍵', [], 0, 'none'],
    ['نسكافيه', 'c_tea', 65, '🍵', [], 0, 'none'],
    ['لوتس ساخن', 'c_tea', 80, '🍵', [], 0, 'none'],
    ['أوريو ساخن', 'c_tea', 90, '🍵', [], 0, 'none'],
    ['سحلب بالمكسرات', 'c_tea', 95, '🍵', [], 0, 'none'],
    ['سحلب بالفواكه', 'c_tea', 105, '🍵', [], 0, 'none'],
    ['آيس وايت موكا', 'c_cold', 95, '🧊', [], 0, 'none'],
    ['آيس بلاك موكا', 'c_cold', 95, '🧊', [], 0, 'none'],
    ['آيس سبانش لاتيه', 'c_cold', 105, '🧊', [], 0, 'none'],
    ['آيس كابتشينو', 'c_cold', 80, '🧊', [], 0, 'none'],
    ['آيس نسكافيه', 'c_cold', 65, '🧊', [], 0, 'none'],
    ['فرابيه فانيليا', 'c_cold', 80, '🧊', [], 0, 'none'],
    ['فرابيه شوكولاتة', 'c_cold', 85, '🧊', [], 0, 'none'],
    ['فرابيه لوتس', 'c_cold', 100, '🧊', [], 0, 'none'],
    ['فرابيه بستاشيو', 'c_cold', 105, '🧊', [], 0, 'none'],
    ['فرابيه أوريو', 'c_cold', 95, '🧊', [], 0, 'none'],
    ['فرابيه توفي', 'c_cold', 95, '🧊', [], 0, 'none'],
    ['آيس ماتشا فراولة', 'c_matcha', 110, '🍵', [], 0, 'none'],
    ['آيس ماتشا فرابيه', 'c_matcha', 105, '🍵', [], 0, 'none'],
    ['آيس ماتشا بلوبيري', 'c_matcha', 102, '🍵', [], 0, 'none'],
    ['آيس ماتشا ميروفا', 'c_matcha', 115, '🍵', [], 0, 'none'],
    ['آيس ماتشا كلاسيك', 'c_matcha', 95, '🍵', [], 0, 'none'],
    ['آيس ماتشا لاتيه', 'c_matcha', 105, '🍵', [], 0, 'none'],
    ['ماتشا ساخن', 'c_matcha', 75, '🍵', [], 0, 'none'],
    ['ميكس آيس كريم 3 سكوب', 'c_sundae', 90, '🍨', [], 0, 'none'],
    ['صنداي أوريو', 'c_sundae', 115, '🍨', [], 0, 'none'],
    ['صنداي كيت كات', 'c_sundae', 125, '🍨', [], 0, 'none'],
    ['صنداي مالتيزرز', 'c_sundae', 120, '🍨', [], 0, 'none'],
    ['صنداي براونيز', 'c_sundae', 135, '🍨', [], 0, 'none'],
    ['صنداي تشيز كيك', 'c_sundae', 140, '🍨', [], 0, 'none'],
    ['صنداي ريد فيلفت', 'c_sundae', 115, '🍨', [], 0, 'none'],
    ['ميلك شيك فراولة', 'c_shake', 80, '🥤', [], 0, 'none'],
    ['ميلك شيك مانجو', 'c_shake', 80, '🥤', [], 0, 'none'],
    ['ميلك شيك موز', 'c_shake', 95, '🥤', [], 0, 'none'],
    ['ميلك شيك بلوبيري', 'c_shake', 95, '🥤', [], 0, 'none'],
    ['ميلك شيك كيوي', 'c_shake', 95, '🥤', [], 0, 'none'],
    ['ميلك شيك لوتس', 'c_shake', 100, '🥤', [], 0, 'none'],
    ['ميلك شيك كراميل', 'c_shake', 95, '🥤', [], 0, 'none'],
    ['ميلك شيك دبي', 'c_shake', 105, '🥤', [], 0, 'none'],
    ['ميلك شيك كريمة اللوز', 'c_shake', 105, '🥤', [], 0, 'none'],
    ['ميلك شيك بندق', 'c_shake', 105, '🥤', [], 0, 'none'],
    ['ميلك شيك توفي كراميل', 'c_shake', 105, '🥤', [], 0, 'none'],
    ['كاندي شيك أوريو', 'c_candy', 90, '🍫', [], 0, 'none'],
    ['كاندي شيك كيت كات', 'c_candy', 105, '🍫', [], 0, 'none'],
    ['كاندي شيك مالتيزرز', 'c_candy', 105, '🍫', [], 0, 'none'],
    ['كاندي شيك تويكس', 'c_candy', 110, '🍫', [], 0, 'none'],
    ['كاندي شيك سنيكرز', 'c_candy', 110, '🍫', [], 0, 'none'],
    ['كاندي شيك كيندر', 'c_candy', 116, '🍫', [], 0, 'none'],
    ['كاندي شيك تشيز كيك', 'c_candy', 120, '🍫', [], 0, 'none'],
    ['كاندي شيك براونى', 'c_candy', 120, '🍫', [], 0, 'none'],
    ['كاندي شيك ريد فيلفت', 'c_candy', 110, '🍫', [], 0, 'none'],
    ['سموذي ليمون نعناع', 'c_smoothie', 50, '🥤', [], 0, 'none'],
    ['سموذي خوخ', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['سموذي باشن فروت', 'c_smoothie', 95, '🥤', [], 0, 'none'],
    ['سموذي بلوبيري', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['سموذي تفاح أخضر', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['سموذي كولادا', 'c_smoothie', 110, '🥤', [], 0, 'none'],
    ['سموذي بطيخ', 'c_smoothie', 65, '🥤', [], 0, 'none'],
    ['سموذي كيوي', 'c_smoothie', 110, '🥤', [], 0, 'none'],
    ['سموذي ريد بيري', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['سموذي أناناس', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['سموذي ميكس بيري', 'c_smoothie', 110, '🥤', [], 0, 'none'],
    ['سموذي مانجو كيوي', 'c_smoothie', 115, '🥤', [], 0, 'none'],
    ['سموذي فيمتو', 'c_smoothie', 98, '🥤', [], 0, 'none'],
    ['زبادي مخفوق فراولة', 'c_yogurt', 77, '🥛', [], 0, 'none'],
    ['زبادي مخفوق بيري', 'c_yogurt', 77, '🥛', [], 0, 'none'],
    ['زبادي مخفوق خوخ', 'c_yogurt', 75, '🥛', [], 0, 'none'],
    ['زبادي مخفوق مانجو', 'c_yogurt', 80, '🥛', [], 0, 'none'],
    ['زبادي مخفوق باشن فروت', 'c_yogurt', 75, '🥛', [], 0, 'none'],
    ['زبادي مخفوق ميكس فواكه', 'c_yogurt', 85, '🥛', [], 0, 'none'],
    ['فاكهة خوخ', 'c_fruits', 75, '🍑', [], 0, 'none'],
    ['فاكهة بطيخ', 'c_fruits', 70, '🍑', [], 0, 'none'],
    ['فاكهة برقوق', 'c_fruits', 85, '🍑', [], 0, 'none'],
    ['فاكهة كانتالوب', 'c_fruits', 75, '🍑', [], 0, 'none'],
    ['فاكهة رمان', 'c_fruits', 75, '🍑', [], 0, 'none'],
    ['فاكهة أفوكادو', 'c_fruits', 140, '🍑', [], 0, 'none'],
    ['فاكهة كيوي', 'c_fruits', 120, '🍑', [], 0, 'none'],
    ['عصير ليمون', 'c_fresh', 50, '🍹', [], 0, 'none'],
    ['عصير جوافة', 'c_fresh', 75, '🍹', [], 0, 'none'],
    ['عصير بنانا', 'c_fresh', 77, '🍹', [], 0, 'none'],
    ['كوكتيل فلوريدا', 'c_cocktail', 85, '🍹', [], 0, 'none'],
    ['كوكتيل هاواي', 'c_cocktail', 85, '🍹', [], 0, 'none'],
    ['كوكتيل أورجانيك', 'c_cocktail', 80, '🍹', [], 0, 'none'],
    ['ميروفا باور', 'c_cocktail', 150, '🍹', [], 0, 'none'],
    ['كوكتيل مانجو كيوي', 'c_cocktail', 110, '🍹', [], 0, 'none'],
    ['سلاشي كوكتيل', 'c_cocktail', 85, '🍹', [], 0, 'none'],
    ['كريزي ليمون', 'c_cocktail', 90, '🍹', [], 0, 'none'],
    ['جوافة نعناع', 'c_cocktail', 80, '🍹', [], 0, 'none'],
    ['فراولة نعناع', 'c_cocktail', 80, '🍹', [], 0, 'none'],
    ['بينا كولادا', 'c_cocktail', 90, '🍹', [], 0, 'none'],
    ['بلو موهيتو', 'c_soda', 70, '🧊', [], 0, 'none'],
    ['بلو هاواي', 'c_soda', 75, '🧊', [], 0, 'none'],
    ['سكوتش مينت', 'c_soda', 70, '🧊', [], 0, 'none'],
    ['إلكتريك بلو', 'c_soda', 90, '🧊', [], 0, 'none'],
    ['تروبيكال', 'c_soda', 70, '🧊', [], 0, 'none'],
    ['صن شاين ستروبري', 'c_soda', 75, '🧊', [], 0, 'none'],
    ['أطلس بلاك', 'c_soda', 80, '🧊', [], 0, 'none'],
    ['شيري كولا', 'c_soda', 65, '🧊', [], 0, 'none'],
    ['بلاك بيري صودا', 'c_soda', 75, '🧊', [], 0, 'none'],
    ['موروفا بلو', 'c_soda', 135, '🧊', [], 0, 'none'],
    ['بول فروج', 'c_soda', 140, '🧊', [], 0, 'none'],
    ['بيبسي', 'c_soft', 40, '🥫', [], 0, 'none'],
    ['سفن', 'c_soft', 40, '🥫', [], 0, 'none'],
    ['شويبس', 'c_soft', 45, '🥫', [], 0, 'none'],
    ['بيريل', 'c_soft', 50, '🥫', [], 0, 'none'],
    ['فيوري', 'c_soft', 45, '🥫', [], 0, 'none'],
    ['فانتا', 'c_soft', 40, '🥫', [], 0, 'none'],
    ['ريد بول', 'c_soft', 90, '🥫', [], 0, 'none'],
    ['تويست', 'c_soft', 43, '🥫', [], 0, 'none'],
    ['مياه', 'c_soft', 12, '🥫', [], 0, 'none'],
    ['كلاسيك مولتن', 'c_dessert', 135, '🍰', [], 0, 'none'],
    ['نوتيلا مولتن', 'c_dessert', 137, '🍰', [], 0, 'none'],
    ['سان سباستيان تشيز كيك', 'c_dessert', 115, '🍰', [], 0, 'none'],
    ['تشوكليت لافرز', 'c_dessert', 125, '🍰', [], 0, 'none'],
    ['أوريو شوكليت', 'c_dessert', 135, '🍰', [], 0, 'none'],
    ['برونز كيك', 'c_dessert', 100, '🍰', [], 0, 'none'],
    ['فادج كيك', 'c_dessert', 105, '🍰', [], 0, 'none'],
    ['تيراميسو', 'c_dessert', 105, '🍰', [], 0, 'none'],
    ['وافل بالصوص بريميوم', 'c_waffle', 125, '🧇', [], 0, 'none'],
    ['وافل فواكه', 'c_waffle', 120, '🧇', [], 0, 'none'],
    ['ميني بان كيك 12 قطعة', 'c_waffle', 80, '🧇', [], 0, 'none'],
    ['ميني بان كيك 24 قطعة', 'c_waffle', 140, '🧇', [], 0, 'none'],
    ['أصابع وافل', 'c_waffle', 70, '🧇', [], 0, 'none'],
    ['وافل موز', 'c_waffle', 105, '🧇', [], 0, 'none'],
    ['بان كيدز', 'c_kids', 145, '🧒', [], 0, 'none'],
    ['ستيك فان', 'c_kids', 140, '🧒', [], 0, 'none'],
    ['تشيز فان', 'c_kids', 155, '🧒', [], 0, 'none'],
    ['جوس فريش (أطفال)', 'c_kids', 100, '🧒', [], 0, 'none'],
    ['سويت صنداي', 'c_kids', 105, '🧒', [], 0, 'none'],
    ['أوريو كيدز', 'c_kids', 165, '🧒', [], 0, 'none'],
    ['مانجو فان', 'c_kids', 140, '🧒', [], 0, 'none'],
  ];

  const products = raw.map(([name, categoryId, price, emoji, groups, extra, stk], i) => ({
    id: `p${String(i + 1).padStart(3, '0')}`,
    name,
    categoryId,
    sku: `HOP-${String(i + 1).padStart(4, '0')}`,
    price: price * 100,
    emoji,
    tone: i % 8,
    stockMode: stk || (categoryId === 'c_dessert' ? 'none' : 'recipe'),
    active: true,
    taxExempt: false,
    modifierGroupIds: groups,
    extraCost: extra ?? 0,
  }));

  const pid = (name) => products.find((p) => p.name === name).id;

  const inventory = [
    { id: 'i_beans', name: 'بن قهوة', baseUnit: 'g', qty: 8200, minQty: 3000, costPerBase: 60, active: true },
    { id: 'i_milk', name: 'لبن', baseUnit: 'ml', qty: 42000, minQty: 15000, costPerBase: 2.8, active: true },
    { id: 'i_sugar', name: 'سكر', baseUnit: 'g', qty: 1800, minQty: 5000, costPerBase: 3, active: true },
    { id: 'i_cream', name: 'كريمة خفق', baseUnit: 'ml', qty: 6500, minQty: 3000, costPerBase: 12, active: true },
    { id: 'i_cocoa', name: 'كاكاو', baseUnit: 'g', qty: 2600, minQty: 1000, costPerBase: 20, active: true },
    { id: 'i_vanilla', name: 'صوص فانيليا', baseUnit: 'ml', qty: 900, minQty: 1500, costPerBase: 8, active: true },
    { id: 'i_caramel', name: 'صوص كراميل', baseUnit: 'ml', qty: 3200, minQty: 1500, costPerBase: 7, active: true },
    { id: 'i_choco', name: 'صوص شوكولاتة', baseUnit: 'ml', qty: 4100, minQty: 1500, costPerBase: 9, active: true },
    { id: 'i_tea', name: 'شاي', baseUnit: 'g', qty: 2400, minQty: 800, costPerBase: 20, active: true },
    { id: 'i_mint', name: 'نعناع', baseUnit: 'g', qty: 350, minQty: 500, costPerBase: 5, active: true },
    { id: 'i_lemon', name: 'ليمون', baseUnit: 'piece', qty: 140, minQty: 60, costPerBase: 150, active: true },
    { id: 'i_mojsyrup', name: 'سيرب موهيتو', baseUnit: 'ml', qty: 5200, minQty: 2000, costPerBase: 6, active: true },
    { id: 'i_soda', name: 'صودا', baseUnit: 'ml', qty: 36000, minQty: 12000, costPerBase: 1.2, active: true },
    { id: 'i_orange', name: 'برتقال', baseUnit: 'g', qty: 18000, minQty: 6000, costPerBase: 1.5, active: true },
    { id: 'i_mango', name: 'مانجو', baseUnit: 'g', qty: 9000, minQty: 4000, costPerBase: 4, active: true },
    { id: 'i_straw', name: 'فراولة', baseUnit: 'g', qty: 3100, minQty: 3000, costPerBase: 6, active: true },
    { id: 'i_flour', name: 'دقيق', baseUnit: 'g', qty: 22000, minQty: 8000, costPerBase: 1.8, active: true },
    { id: 'i_eggs', name: 'بيض', baseUnit: 'piece', qty: 160, minQty: 60, costPerBase: 300, active: true },
    { id: 'i_butter', name: 'زبدة', baseUnit: 'g', qty: 4800, minQty: 2000, costPerBase: 14, active: true },
    {
      id: 'i_icecream',
      name: 'آيس كريم فانيليا',
      baseUnit: 'ml',
      qty: 14000,
      minQty: 5000,
      costPerBase: 8,
      active: true,
    },
    { id: 'i_nutella', name: 'نوتيلا', baseUnit: 'g', qty: 2200, minQty: 1000, costPerBase: 15, active: true },
    { id: 'i_oreo', name: 'بسكويت أوريو', baseUnit: 'g', qty: 3000, minQty: 1000, costPerBase: 9, active: true },
    { id: 'i_romi', name: 'جبنة رومي', baseUnit: 'g', qty: 5200, minQty: 2000, costPerBase: 18, active: true },
    { id: 'i_bread', name: 'خبز ساندويتش', baseUnit: 'piece', qty: 90, minQty: 40, costPerBase: 150, active: true },
    { id: 'i_bun', name: 'خبز برجر', baseUnit: 'piece', qty: 70, minQty: 40, costPerBase: 200, active: true },
    { id: 'i_patty', name: 'قرص برجر لحم', baseUnit: 'piece', qty: 55, minQty: 40, costPerBase: 1200, active: true },
    { id: 'i_chicken', name: 'صدر فراخ', baseUnit: 'g', qty: 7800, minQty: 3000, costPerBase: 12, active: true },
    {
      id: 'i_cheddar',
      name: 'جبنة شيدر (شريحة)',
      baseUnit: 'piece',
      qty: 120,
      minQty: 50,
      costPerBase: 250,
      active: true,
    },
  ];

  const L = (inventoryId, qty, unit = 'g') => ({ inventoryId, qty, unit });
  const sugar = L('i_sugar', 5);

  const recipes = {
    [pid('إسبريسو')]: [L('i_beans', 9), sugar],
    [pid('أمريكانو')]: [L('i_beans', 18), sugar],
    [pid('كابتشينو')]: [L('i_beans', 18), L('i_milk', 150, 'ml'), sugar],
    [pid('لاتيه')]: [L('i_beans', 18), L('i_milk', 200, 'ml'), sugar],
    [pid('موكا')]: [L('i_beans', 18), L('i_milk', 150, 'ml'), L('i_choco', 25, 'ml')],
    [pid('كراميل ماكياتو')]: [
      L('i_beans', 18),
      L('i_milk', 150, 'ml'),
      L('i_caramel', 20, 'ml'),
      L('i_vanilla', 10, 'ml'),
    ],
    [pid('قهوة تركية')]: [L('i_beans', 10), sugar],
    [pid('هوت شوكليت')]: [L('i_cocoa', 30), L('i_milk', 200, 'ml'), L('i_cream', 20, 'ml')],
    [pid('آيس لاتيه')]: [L('i_beans', 18), L('i_milk', 180, 'ml'), sugar],
    [pid('آيس موكا')]: [L('i_beans', 18), L('i_milk', 160, 'ml'), L('i_choco', 30, 'ml'), L('i_cream', 20, 'ml')],
    [pid('آيس كراميل ماكياتو')]: [L('i_beans', 18), L('i_milk', 160, 'ml'), L('i_caramel', 25, 'ml')],
    [pid('آيس بستاشيو لاتيه')]: [
      L('i_beans', 18),
      L('i_milk', 180, 'ml'),
      L('i_vanilla', 20, 'ml'),
      L('i_cream', 20, 'ml'),
    ],
    [pid('آيس أمريكانو')]: [L('i_beans', 18), sugar],
    [pid('فرابيه كراميل')]: [
      L('i_beans', 18),
      L('i_milk', 150, 'ml'),
      L('i_caramel', 30, 'ml'),
      L('i_cream', 30, 'ml'),
    ],
    [pid('شاي')]: [L('i_tea', 3), sugar],
    [pid('شاي بالنعناع')]: [L('i_tea', 3), L('i_mint', 3), sugar],
    [pid('سحلب')]: [L('i_milk', 250, 'ml'), L('i_sugar', 15)],
    [pid('ينسون')]: [L('i_tea', 2), sugar],
    [pid('موهيتو')]: [L('i_lemon', 1, 'piece'), L('i_mint', 5), L('i_mojsyrup', 30, 'ml'), L('i_soda', 150, 'ml')],
    [pid('موهيتو فراولة')]: [
      L('i_lemon', 1, 'piece'),
      L('i_mint', 5),
      L('i_straw', 40),
      L('i_mojsyrup', 30, 'ml'),
      L('i_soda', 150, 'ml'),
    ],
    [pid('عصير برتقال')]: [L('i_orange', 400)],
    [pid('ليمون بالنعناع')]: [L('i_lemon', 2, 'piece'), L('i_mint', 5), L('i_sugar', 20)],
    [pid('عصير مانجو')]: [L('i_mango', 250), L('i_sugar', 10), L('i_milk', 50, 'ml')],
    [pid('عصير فراولة')]: [L('i_straw', 220), L('i_sugar', 10), L('i_milk', 50, 'ml')],
    [pid('سموذي مانجو')]: [L('i_mango', 200), L('i_milk', 100, 'ml'), L('i_sugar', 10)],
    [pid('سموذي فراولة')]: [L('i_straw', 180), L('i_milk', 100, 'ml'), L('i_sugar', 10)],
    [pid('ميلك شيك شوكولاتة')]: [
      L('i_icecream', 150, 'ml'),
      L('i_milk', 150, 'ml'),
      L('i_choco', 30, 'ml'),
      L('i_cream', 20, 'ml'),
    ],
    [pid('ميلك شيك فانيليا')]: [L('i_icecream', 170, 'ml'), L('i_milk', 150, 'ml'), L('i_vanilla', 15, 'ml')],
    [pid('ميلك شيك أوريو')]: [
      L('i_icecream', 150, 'ml'),
      L('i_milk', 150, 'ml'),
      L('i_oreo', 40),
      L('i_cream', 20, 'ml'),
    ],
    [pid('وافل')]: [
      L('i_flour', 120),
      L('i_eggs', 1, 'piece'),
      L('i_milk', 100, 'ml'),
      L('i_butter', 20),
      L('i_sugar', 15),
      L('i_choco', 30, 'ml'),
    ],
    [pid('بان كيك')]: [
      L('i_flour', 100),
      L('i_eggs', 1, 'piece'),
      L('i_milk', 100, 'ml'),
      L('i_butter', 15),
      L('i_sugar', 15),
    ],
    [pid('وافل نوتيلا')]: [
      L('i_flour', 120),
      L('i_eggs', 1, 'piece'),
      L('i_milk', 100, 'ml'),
      L('i_butter', 20),
      L('i_nutella', 40),
    ],
    [pid('بان كيك فواكه')]: [
      L('i_flour', 100),
      L('i_eggs', 1, 'piece'),
      L('i_milk', 100, 'ml'),
      L('i_straw', 60),
      L('i_mango', 40),
    ],
    [pid('ساندويتش جبنة رومي')]: [L('i_bread', 1, 'piece'), L('i_romi', 80)],
    [pid('كلوب ساندويتش')]: [
      L('i_bread', 2, 'piece'),
      L('i_chicken', 90),
      L('i_cheddar', 1, 'piece'),
      L('i_eggs', 1, 'piece'),
    ],
    [pid('شاورما فراخ')]: [L('i_bread', 1, 'piece'), L('i_chicken', 130)],
    [pid('تشيكن راب')]: [L('i_bread', 1, 'piece'), L('i_chicken', 110), L('i_cheddar', 1, 'piece')],
    [pid('برجر كلاسيك')]: [L('i_bun', 1, 'piece'), L('i_patty', 1, 'piece')],
    [pid('تشيز برجر')]: [L('i_bun', 1, 'piece'), L('i_patty', 1, 'piece'), L('i_cheddar', 1, 'piece')],
    [pid('دبل برجر')]: [L('i_bun', 1, 'piece'), L('i_patty', 2, 'piece'), L('i_cheddar', 2, 'piece')],
    [pid('تشيكن برجر')]: [L('i_bun', 1, 'piece'), L('i_chicken', 150), L('i_cheddar', 1, 'piece')],
  };

  return { categories, modifierGroups, products, inventory, recipes };
})();

// ===== 05-core.js =====
// ---------------------------------------------------------------------------
// المجال (Domain): ثوابت ومساعدات تُستخدم في الحالة والشاشات
// ---------------------------------------------------------------------------
const LS_KEY = 'hyperone.demo.v1';
const STATE_VERSION = 1;
const ORDER_TYPES = { dine_in: 'صالة', takeaway: 'تيك أواي', delivery: 'ديليفري' };
const METHOD_ICON = { cash: '💵', card: '💳', wallet: '📱', other: '🧾' };
const METHOD_LABEL = { cash: 'نقدي', card: 'بطاقة بنكية', wallet: 'محفظة إلكترونية', other: 'أخرى' };
const STATUS_LABEL = { pending: 'قيد التنفيذ', held: 'معلّق', completed: 'مكتمل', cancelled: 'ملغي' };
const MOVE_LABEL = {
  adjust: 'تسوية', waste: 'هالك', receive: 'استلام', sale: 'بيع', refund_restore: 'استرجاع مرتجع', count: 'جرد',
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

function defaultSettings() {
  return {
    business: {
      name: 'كوفي', branch: 'الفرع الرئيسي', address: 'المنيا - مصر', phone: '01012345678',
      email: 'cafe@example.com', logo: '', mode: 'cafe',
    },
    regional: { dateFormat: 'dd/MM/yyyy', timeFormat: '12' },
    invoice: {
      prefix: 'INV-', header: 'أهلًا بكم في كوفي', footer: 'شكرًا لزيارتكم — نتمنى رؤيتكم قريبًا',
      paperWidth: 80, fontSize: 12, copies: 1, autoPrint: true,
    },
    tax: { enabled: true, ratePct: 14, mode: 'exclusive', rounding: 'half_up' },
    discounts: {
      allowFixed: true, allowPercent: true, maxPercent: 20, maxFixed: 50000, requireApprovalAbovePercent: 10,
    },
    inventory: { defaultMinQty: 1000, insufficientStock: 'allow', restoreOnRefund: true },
    payments: {
      methods: [
        { key: 'cash', label: 'نقدي', enabled: true },
        { key: 'card', label: 'بطاقة بنكية', enabled: true },
        { key: 'wallet', label: 'محفظة إلكترونية', enabled: true },
        { key: 'other', label: 'أخرى', enabled: true },
      ],
      allowPartial: false,
    },
    refunds: { requireReason: true, methods: ['cash', 'card', 'wallet', 'other'] },
    appearance: { theme: 'light', sidebarCompact: false },
    notify: { enabled: false, botToken: '', chatId: '' },
  };
}

// ----- أدوات السلة / الطلب -----
function defaultOptionsFor(product, groups) {
  const out = [];
  for (const gid of product.modifierGroupIds) {
    const g = groups.find((x) => x.id === gid);
    if (!g) continue;
    let defs = g.options.filter((o) => o.isDefault);
    if (g.id === 'g_temp' && product.categoryId === 'c_cold') defs = g.options.filter((o) => o.id === 'iced');
    for (const o of defs) out.push({ groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, price: o.price });
  }
  return out;
}

function cartItemFrom(product, options, qty = 1, note = '') {
  return {
    key: uid('ci'), productId: product.id, name: product.name, emoji: product.emoji, tone: product.tone,
    image: product.image || '', basePrice: product.price, options, qty, note, taxExempt: !!product.taxExempt,
  };
}

function weightItemFrom(product, grams) {
  const it = cartItemFrom(product, [], 1, '');
  it.weightG = grams;
  it.pricePerKg = product.price;
  it.basePrice = Math.round((product.price * grams) / 1000);
  return it;
}
const isWeight = (p) => p.unitType === 'weight';
function stockLabelDirect(p) { return isWeight(p) ? `${fmtQty((p.stockQty || 0) / 1000)} كجم` : `${fmtQty(p.stockQty || 0)} قطعة`; }

function optionsSignature(options) {
  return options.map((o) => `${o.groupId}:${o.optionId}`).sort().join('|');
}

function emptyCart() {
  return {
    items: [], type: (typeof S !== 'undefined' && S && S.settings && S.settings.business.mode === 'market') ? 'takeaway' : 'dine_in', tableId: null, note: '', customerId: null, orderId: null,
    delivery: { name: '', phone: '', address: '', fee: 0 },
    discount: { type: null, value: 0, reason: '', approvedBy: '' },
  };
}

function nextNo(st, kind) {
  st.counters[kind] += 1;
  const n = st.counters[kind];
  if (kind === 'order') return `${st.settings.invoice.prefix}${pad(n, 6)}`;
  if (kind === 'refund') return `RF-${pad(n, 6)}`;
  if (kind === 'purchase') return `PUR-${pad(n, 4)}`;
  return String(n);
}

function productCost(st, productId, line) {
  const p = st.products.find((x) => x.id === productId);
  if (!p) return { ingredients: 0, extra: 0, total: 0 };
  if (p.stockMode === 'direct') {
    const c = line && line.weightG ? Math.round(((p.costPrice || 0) * line.weightG) / 1000) : (p.costPrice || 0);
    return { ingredients: c, extra: 0, total: c };
  }
  return productUnitCost(p, st.recipes, st.inventory);
}

/** يحسب الإجماليات وعناصر الطلب (مع لقطة التكلفة) من السلة */
function cartFee(c) { return c.type === 'delivery' && c.items.length ? ((c.delivery && c.delivery.fee) || 0) : 0; }
function deliveryOf(c) { if (!c.delivery) c.delivery = { name: '', phone: '', address: '', fee: 0 }; return c.delivery; }
function deliveryError(c) {
  if (c.type !== 'delivery') return '';
  const d = c.delivery || {};
  if (!/^[0-9+\-\s]{8,}$/.test(String(d.phone || '').trim())) return 'أدخل رقم موبايل العميل للديليفري';
  if (!String(d.address || '').trim()) return 'أدخل عنوان التوصيل';
  return '';
}

function composeOrder(st, cart, prevItems = []) {
  const discount = cart.discount && cart.discount.type ? { type: cart.discount.type, value: cart.discount.value } : null;
  const totals = priceCart(cart.items, discount, st.settings);
  totals.deliveryFee = cartFee(cart);
  totals.total += totals.deliveryFee;
  const items = toOrderItems(cart.items, totals, (pid, c) => productCost(st, pid, c).total, prevItems);
  // لقطة تكلفة ثابتة: إن وُجدت تكلفة سابقة لنفس العنصر نحافظ عليها
  items.forEach((it) => {
    const old = prevItems.find((p) => p.key === it.key);
    if (old) it.unitCost = old.unitCost;
  });
  return { totals, items, cogs: sum(items, (i) => i.unitCost * i.qty) };
}

function makeOrder(st, cart, meta) {
  const comp = composeOrder(st, cart, []);
  const t = comp.totals;
  const iso = meta.createdAt || new Date().toISOString();
  return {
    id: uid('o'), no: nextNo(st, 'order'), type: cart.type,
    tableId: cart.type === 'dine_in' ? cart.tableId : null, customerId: cart.customerId || null,
    status: meta.status || 'pending', awaitingPayment: false, note: cart.note || '', items: comp.items,
    discount: { type: t.discountType, value: t.discountValue, reason: cart.discount.reason || '', approvedBy: cart.discount.approvedBy || '' },
    subtotal: t.subtotal, discountAmount: t.discountAmount, taxAmount: t.taxAmount, netSales: t.netSales, total: t.total,
    deliveryFee: t.deliveryFee || 0, delivery: cart.type === 'delivery' ? clone(cart.delivery || null) : null,
    payments: [], paid: 0, change: 0, cogs: comp.cogs,
    taxSnapshot: { enabled: st.settings.tax.enabled, rateBps: Math.round(st.settings.tax.ratePct * 100), mode: st.settings.tax.mode },
    cashier: meta.cashier || '—', createdAt: iso, updatedAt: iso, refundedAmount: 0, demo: !!meta.demo,
  };
}

// ----- ملخصات مشتقة (تُحسب من السجلات دائمًا) -----
function activeOrderForTable(st, number) {
  return st.orders.find((o) => (o.status === 'pending' || o.status === 'held') && o.type === 'dine_in' && o.tableId === number) || null;
}

function tableState(st, number) {
  const order = activeOrderForTable(st, number);
  const meta = st.tables.find((t) => t.number === number);
  if (order) return { status: order.awaitingPayment ? 'wait' : 'busy', order };
  if (meta && meta.reserved) return { status: 'res', order: null };
  return { status: 'free', order: null };
}

function shiftWindow(st, shift) {
  return [new Date(shift.openedAt).getTime(), shift.closedAt ? new Date(shift.closedAt).getTime() : Date.now() + 1000];
}

/** ملخص الوردية: النقدي فقط يدخل في النقدية المتوقعة */
function shiftSummary(st, shift) {
  const [a, b] = shiftWindow(st, shift);
  const inWin = (iso) => {
    const t = new Date(iso).getTime();
    return t >= a && t <= b;
  };
  const orders = st.orders.filter((o) => o.status === 'completed' && o.paidAt && inWin(o.paidAt));
  const by = { cash: 0, card: 0, wallet: 0, other: 0 };
  let tendered = 0;
  orders.forEach((o) => o.payments.forEach((p) => { by[p.method] = (by[p.method] || 0) + p.amount; if (p.method === 'cash') tendered += p.tendered || p.amount; }));
  const moves = st.cashMovements.filter((m) => m.shiftId === shift.id);
  const deposits = sum(moves.filter((m) => m.type === 'deposit'), (m) => m.amount);
  const withdrawals = sum(moves.filter((m) => m.type === 'withdrawal'), (m) => m.amount);
  const refunds = st.refunds.filter((r) => inWin(r.at));
  const cashRefunds = sum(refunds.filter((r) => r.method === 'cash'), (r) => r.amount);
  const otherRefunds = sum(refunds.filter((r) => r.method !== 'cash'), (r) => r.amount);
  const cashExpenses = sum(st.expenses.filter((e) => !e.cancelled && e.method === 'cash' && inWin(e.at)), (e) => e.amount);
  const expected = expectedCash({
    opening: shift.openingCash, cashSales: by.cash, deposits, withdrawals, cashRefunds, cashExpenses,
  });
  return {
    orders: orders.length, sales: sum(orders, (o) => o.total), by, deposits, withdrawals, cashRefunds, otherRefunds,
    cashExpenses, expected, moves,
  };
}

function supplierBalance(st, id) {
  const s = st.suppliers.find((x) => x.id === id);
  if (!s) return 0;
  const ps = st.purchases.filter((p) => p.supplierId === id && p.status === 'received');
  return s.openingBalance + sum(ps, (p) => purchaseTotal(p)) - sum(ps, (p) => p.paid);
}

function purchaseTotal(p) {
  return sum(p.lines, (l) => Math.round(l.qty * l.unitPrice));
}

function lowStockItems(st) {
  const direct = st.products.filter((p) => p.active && p.stockMode === 'direct' && (p.stockQty || 0) <= (p.minQty || 0))
    .map((p) => ({ id: p.id, name: p.name, qty: p.stockQty || 0, minQty: p.minQty || 0, baseUnit: p.unitType === 'weight' ? 'g' : 'piece', active: true }));
  return st.inventory.filter((i) => i.active && i.qty <= i.minQty).concat(direct);
}

function stockStatus(i) {
  if (i.qty <= 0) return 'out';
  if (i.qty <= i.minQty) return 'low';
  return 'ok';
}

function periodRange(kind, custom) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from = start;
  let to = new Date(start.getTime() + 86400000 - 1);
  if (kind === 'week') from = new Date(start.getTime() - 6 * 86400000);
  else if (kind === 'month') from = new Date(start.getTime() - 29 * 86400000);
  else if (kind === 'custom' && custom) {
    from = new Date(custom.from + 'T00:00:00');
    to = new Date(custom.to + 'T23:59:59');
  }
  return [from.getTime(), to.getTime()];
}

function ordersIn(st, range) {
  return st.orders.filter((o) => o.status === 'completed' && o.paidAt && new Date(o.paidAt).getTime() >= range[0] && new Date(o.paidAt).getTime() <= range[1]);
}

function refundsIn(st, range) {
  return st.refunds.filter((r) => new Date(r.at).getTime() >= range[0] && new Date(r.at).getTime() <= range[1]);
}

function expensesIn(st, range) {
  return st.expenses.filter((e) => !e.cancelled && new Date(e.at).getTime() >= range[0] && new Date(e.at).getTime() <= range[1]);
}

/** مؤشرات الأعمال للفترة. الربح الإجمالي = صافي المبيعات (بدون ضريبة) − تكلفة البضاعة؛ والمرتجعات تُخصم بنسبتها. */
function kpis(st, range) {
  const orders = ordersIn(st, range);
  const refunds = refundsIn(st, range);
  const gross = sum(orders, (o) => o.subtotal);
  const discounts = sum(orders, (o) => o.discountAmount);
  const tax = sum(orders, (o) => o.taxAmount);
  const total = sum(orders, (o) => o.total);
  const refundTotal = sum(refunds, (r) => r.amount);
  const net = sum(orders, (o) => o.netSales);
  const cogs = sum(orders, (o) => o.cogs);
  // تقدير المرتجعات: نسبة الاسترجاع من كل طلب مطبّقة على صافي المبيعات والتكلفة
  let refundNet = 0;
  let refundCogs = 0;
  for (const o of orders) {
    for (const it of o.items) {
      if (!it.refundedQty) continue;
      refundNet += it.totalAlloc ? Math.round((it.netAlloc * it.refundedAmount) / it.totalAlloc) : 0;
      refundCogs += it.unitCost * it.refundedQty;
    }
  }
  const expenses = sum(expensesIn(st, range), (e) => e.amount);
  const netAfterRefunds = net - refundNet;
  const cogsAfter = cogs - refundCogs;
  const grossProfit = netAfterRefunds - cogsAfter;
  return {
    orders, count: orders.length, gross, discounts, tax, total, refundTotal, net, netAfterRefunds, cogs: cogsAfter,
    grossProfit, expenses, netProfit: grossProfit - expenses, avg: orders.length ? Math.round(total / orders.length) : 0,
  };
}

function groupByDay(orders, range) {
  const map = new Map();
  for (let t = range[0]; t <= range[1]; t += 86400000) map.set(dayKey(new Date(t)), 0);
  orders.forEach((o) => {
    const k = dayKey(o.paidAt);
    if (map.has(k)) map.set(k, map.get(k) + o.total);
  });
  return [...map.entries()].map(([k, v]) => ({ day: k, value: v }));
}

function topProducts(orders, limit = 6) {
  const m = new Map();
  orders.forEach((o) => o.items.forEach((i) => {
    const e = m.get(i.productId) || { name: i.name, emoji: i.emoji, qty: 0, revenue: 0 };
    e.qty += i.qty - i.refundedQty;
    e.revenue += i.totalAlloc - i.refundedAmount;
    m.set(i.productId, e);
  }));
  return [...m.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

function paymentBreakdown(orders) {
  const by = {};
  orders.forEach((o) => o.payments.forEach((p) => { by[p.method] = (by[p.method] || 0) + p.amount; }));
  return by;
}

// ===== 10-seed.js =====
// ---------------------------------------------------------------------------
// بيانات العرض التجريبية (Seed). كل ما هنا بيانات وهمية للمعاينة فقط.
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLE_SEED = [
  { id: 'r_admin', label: 'مدير النظام', system: true, permissions: ['*'] },
  {
    id: 'r_manager', label: 'مدير', system: true,
    permissions: ['page.dashboard', 'page.cashier', 'page.tables', 'page.orders', 'page.products', 'page.categories', 'page.recipes', 'page.inventory', 'page.purchases', 'page.suppliers', 'page.expenses', 'page.customers', 'page.reports', 'page.cashbox', 'page.printers', 'page.settings', 'discount.apply', 'discount.approve', 'catalog.edit', 'inventory.adjust', 'page.attendance', 'attendance.manage', 'orders.cancel'],
  },
  {
    id: 'r_cashier', label: 'كاشير', system: true,
    permissions: ['page.dashboard', 'page.cashier', 'page.tables', 'page.orders', 'page.customers', 'page.cashbox', 'discount.apply', 'page.attendance'],
  },
  {
    id: 'r_inventory', label: 'موظف مخزون', system: true,
    permissions: ['page.dashboard', 'page.recipes', 'page.inventory', 'page.purchases', 'page.suppliers', 'page.expenses', 'inventory.adjust', 'page.attendance'],
  },
];

function buildSeed() {
  const now = Date.now();
  const rnd = mulberry32(20261012);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ago = (ms) => new Date(now - ms).toISOString();
  const atDay = (d, h, m = 0) => {
    const x = new Date(now);
    x.setDate(x.getDate() - d);
    x.setHours(h, m, 0, 0);
    return x;
  };

  const st = {
    v: STATE_VERSION,
    auth: { userId: null },
    settings: defaultSettings(),
    categories: clone(SEED.categories),
    modifierGroups: clone(SEED.modifierGroups),
    products: clone(SEED.products),
    inventory: clone(SEED.inventory),
    recipes: clone(SEED.recipes),
    movements: [],
    orders: [],
    refunds: [],
    suppliers: [],
    purchases: [],
    expenses: [],
    customers: [],
    roles: clone(ROLE_SEED),
    users: [
      { id: 'u_admin', name: 'أحمد المدير', username: 'admin', roleId: 'r_admin', active: true, lastActive: ago(5 * 60000) },
      { id: 'u_manager', name: 'منى مديرة الفرع', username: 'manager', roleId: 'r_manager', active: true, lastActive: ago(95 * 60000) },
      { id: 'u_cashier', name: 'سارة الكاشير', username: 'cashier', roleId: 'r_cashier', active: true, lastActive: ago(2 * 60000) },
      { id: 'u_cashier2', name: 'محمود الكاشير', username: 'cashier2', roleId: 'r_cashier', active: true, lastActive: ago(26 * 3600000) },
      { id: 'u_store', name: 'كريم أمين المخزن', username: 'store', roleId: 'r_inventory', active: true, lastActive: ago(4 * 3600000) },
    ],
    shifts: [],
    cashMovements: [],
    printers: [
      { role: 'receipt', name: 'طابعة الكاشير (إيصالات)', connection: 'usb', device: 'EPSON TM-T20 (USB)', host: '', port: 9100, paperWidth: 80, copies: 1, autoPrint: true, simulatedStatus: 'connected', lastTest: null },
      { role: 'kitchen', name: 'طابعة المطبخ / البار', connection: 'lan', device: '', host: '192.168.1.60', port: 9100, paperWidth: 80, copies: 1, autoPrint: true, simulatedStatus: 'connected', lastTest: null },
    ],
    tables: Array.from({ length: 20 }, (_, i) => ({
      number: i + 1, seats: [2, 2, 4, 4, 4, 2, 2, 4, 6, 6, 2, 4, 4, 4, 6, 2, 4, 4, 8, 8][i], reserved: i + 1 === 6 || i + 1 === 13,
    })),
    counters: { order: 0, refund: 0, purchase: 40 },
    cart: emptyCart(),
    refundReqs: [],
    attendance: [],
    auditLog: [],
    uoms: defaultUoms(),
    backupLog: [],
  };

  st.suppliers = [
    { id: 's1', name: 'شركة الأتيان للألبان', phone: '01011112222', email: 'sales@atyan.example', address: 'المنيا - المنطقة الصناعية', notes: 'توريد أسبوعي', openingBalance: 0, active: true },
    { id: 's2', name: 'شركة البن الذهبي', phone: '01022223333', email: 'info@goldbean.example', address: 'القاهرة - مدينة نصر', notes: '', openingBalance: 120000, active: true },
    { id: 's3', name: 'شركة السكر المصرية', phone: '01033334444', email: '', address: 'أسيوط', notes: 'سكر ودقيق', openingBalance: 0, active: true },
    { id: 's4', name: 'مصنع الكريمة', phone: '01044445555', email: '', address: 'الجيزة', notes: '', openingBalance: 0, active: true },
    { id: 's5', name: 'شركة المشروبات والعصائر', phone: '01055556666', email: 'drinks@example.com', address: 'المنيا', notes: 'سيرب وصودا', openingBalance: 45000, active: true },
    { id: 's6', name: 'مورد الخضار والفاكهة', phone: '01066667777', email: '', address: 'سوق المنيا', notes: 'توريد يومي', openingBalance: 0, active: true },
    { id: 's7', name: 'مورد اللحوم والدواجن', phone: '01077778888', email: '', address: 'المنيا', notes: '', openingBalance: 0, active: true },
  ];

  st.customers = [
    { id: 'c1', name: 'خالد عبد الرحمن', phone: '01012340001', email: 'khaled@example.com', notes: 'عميل دائم', balance: 0, active: true },
    { id: 'c2', name: 'نورهان محمد', phone: '01012340002', email: '', notes: '', balance: 0, active: true },
    { id: 'c3', name: 'شركة النور للتجارة', phone: '0862345678', email: 'info@alnour.example', notes: 'طلبات اجتماعات', balance: 35000, active: true },
    { id: 'c4', name: 'ياسمين علي', phone: '01012340004', email: '', notes: '', balance: 0, active: true },
    { id: 'c5', name: 'عمر حسن', phone: '01012340005', email: '', notes: 'يفضل بدون سكر', balance: 0, active: true },
    { id: 'c6', name: 'هدى إبراهيم', phone: '01012340006', email: 'hoda@example.com', notes: '', balance: 0, active: true },
    { id: 'c7', name: 'مكتب الأمل للمحاماة', phone: '0862346677', email: '', notes: 'توصيل صباحي', balance: 12000, active: true },
    { id: 'c8', name: 'مصطفى كامل', phone: '01012340008', email: '', notes: '', balance: 0, active: true },
  ];

  // ----- طلبات التاريخ التجريبية (30 يومًا) -----
  const prods = st.products.filter((p) => p.active);
  const cashiers = ['سارة الكاشير', 'محمود الكاشير'];
  const methods = ['cash', 'cash', 'cash', 'card', 'card', 'wallet'];
  const reasons = ['خطأ في الطلب', 'مشكلة في الجودة', 'تأخر الطلب', 'طلب العميل'];

  function randomCart(type) {
    const cart = emptyCart();
    cart.type = type;
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k += 1) {
      const p = prods[Math.floor(Math.pow(rnd(), 1.5) * prods.length)];
      const opts = defaultOptionsFor(p, st.modifierGroups);
      if (rnd() < 0.25) {
        const g = st.modifierGroups.find((x) => p.modifierGroupIds.includes(x.id) && x.multi);
        if (g) { const o = pick(g.options); opts.push({ groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, price: o.price }); }
      }
      cart.items.push(cartItemFrom(p, opts, 1 + (rnd() < 0.3 ? 1 : 0), ''));
    }
    return cart;
  }

  const orderLog = [];
  for (let d = 29; d >= 0; d -= 1) {
    const dow = atDay(d, 12).getDay();
    let n = 9 + Math.floor(rnd() * 10) + (dow === 5 || dow === 4 ? 6 : 0);
    if (d === 0) n = 8;
    for (let k = 0; k < n; k += 1) {
      const lastMs = d === 0 ? now - 20 * 60000 : atDay(d, 23, 0).getTime();
      const firstMs = atDay(d, 9, 0).getTime();
      if (lastMs <= firstMs) continue;
      const created = new Date(firstMs + rnd() * (lastMs - firstMs));
      const typeR = rnd();
      const type = typeR < 0.55 ? 'dine_in' : typeR < 0.9 ? 'takeaway' : 'delivery';
      const cart = randomCart(type);
      if (type === 'dine_in') cart.tableId = 1 + Math.floor(rnd() * 20);
      if (rnd() < 0.08) cart.discount = { type: 'percent', value: 1000, reason: 'خصم عميل دائم', approvedBy: 'منى مديرة الفرع' };
      if (rnd() < 0.2) cart.customerId = pick(st.customers).id;
      const o = makeOrder(st, cart, { status: 'completed', createdAt: created.toISOString(), cashier: pick(cashiers), demo: true });
      const paidAt = new Date(created.getTime() + (8 + Math.floor(rnd() * 25)) * 60000);
      o.paidAt = paidAt.toISOString();
      o.updatedAt = o.paidAt;
      const split = rnd() < 0.1 && o.total > 4000;
      if (split) {
        const first = Math.round(o.total / 2 / 100) * 100;
        o.payments = [{ method: 'cash', amount: first, tendered: first }, { method: 'card', amount: o.total - first }];
      } else {
        const m = pick(methods);
        if (m === 'cash') {
          const tendered = Math.ceil(o.total / 500) * 500;
          o.payments = [{ method: 'cash', amount: o.total, tendered }];
          o.change = tendered - o.total;
        } else o.payments = [{ method: m, amount: o.total }];
      }
      o.paid = o.total;
      o.items.forEach((i) => { i.kitchenQty = i.qty; });
      orderLog.push(o);
    }
  }
  st.orders = orderLog.sort((a, b) => a.paidAt.localeCompare(b.paidAt));

  // مرتجعات تجريبية على بعض الطلبات
  const refundable = st.orders.filter((o) => {
    const age = (now - new Date(o.paidAt).getTime()) / 86400000;
    return age > 1 && age < 20;
  });
  for (let k = 0; k < 8 && refundable.length; k += 1) {
    const o = refundable.splice(Math.floor(rnd() * refundable.length), 1)[0];
    const item = o.items[0];
    const amount = refundItemAmount(item, 1);
    item.refundedQty += 1;
    item.refundedAmount += amount;
    o.refundedAmount += amount;
    const method = o.payments[0].method;
    st.refunds.push({
      id: uid('rf'), ref: nextNo(st, 'refund'), orderId: o.id, orderNo: o.no, amount, method, reason: pick(reasons),
      items: [{ itemIndex: 0, name: item.name, qty: 1, amount }],
      at: new Date(new Date(o.paidAt).getTime() + 3600000).toISOString(), by: 'أحمد المدير', note: '',
    });
  }
  st.refunds.sort((a, b) => a.at.localeCompare(b.at));

  // ----- طلبات مفتوحة على الطاولات (للشاشة الحية) -----
  const openSpecs = [
    { table: 1, mins: 25, names: ['كابتشينو', 'لاتيه'], wait: false },
    { table: 3, mins: 12, names: ['موهيتو', 'وافل', 'عصير برتقال'], wait: false },
    { table: 5, mins: 85, names: ['برجر كلاسيك', 'ميلك شيك شوكولاتة'], wait: true },
    { table: 8, mins: 5, names: ['أمريكانو'], wait: false },
  ];
  for (const spec of openSpecs) {
    const cart = emptyCart();
    cart.type = 'dine_in';
    cart.tableId = spec.table;
    spec.names.forEach((nm) => {
      const p = st.products.find((x) => x.name === nm);
      cart.items.push(cartItemFrom(p, defaultOptionsFor(p, st.modifierGroups), 1, ''));
    });
    const o = makeOrder(st, cart, { status: 'pending', createdAt: ago(spec.mins * 60000), cashier: 'سارة الكاشير', demo: true });
    o.awaitingPayment = spec.wait;
    o.items.forEach((i) => { i.kitchenQty = i.qty; });
    st.orders.push(o);
  }
  {
    const cart = emptyCart();
    cart.type = 'takeaway';
    const p = st.products.find((x) => x.name === 'آيس لاتيه');
    cart.items.push(cartItemFrom(p, defaultOptionsFor(p, st.modifierGroups), 2, ''));
    st.orders.push(makeOrder(st, cart, { status: 'held', createdAt: ago(40 * 60000), cashier: 'محمود الكاشير', demo: true }));
  }

  // ----- المشتريات والمخزون -----
  const mv = (inventoryId, type, delta, reason, at) => st.movements.push({ id: uid('mv'), inventoryId, type, delta, reason, at, ref: '' });
  const P = (supplierId, daysAgo, status, lines, paid, note = '') => ({
    id: uid('pu'), no: nextNo(st, 'purchase'), supplierId, date: dayKey(atDay(daysAgo, 12)), status, lines, paid, note,
    receivedAt: status === 'received' ? atDay(daysAgo, 13).toISOString() : undefined,
  });
  st.purchases = [
    P('s2', 9, 'received', [{ inventoryId: 'i_beans', qty: 10, unit: 'kg', unitPrice: 60000 }], 600000),
    P('s1', 6, 'received', [{ inventoryId: 'i_milk', qty: 60, unit: 'liter', unitPrice: 2800 }], 168000),
    P('s3', 4, 'received', [{ inventoryId: 'i_sugar', qty: 25, unit: 'kg', unitPrice: 3000 }, { inventoryId: 'i_flour', qty: 20, unit: 'kg', unitPrice: 1800 }], 60000),
    P('s4', 3, 'received', [{ inventoryId: 'i_cream', qty: 5, unit: 'liter', unitPrice: 12000 }], 30000),
    P('s5', 1, 'draft', [{ inventoryId: 'i_mojsyrup', qty: 6, unit: 'liter', unitPrice: 6000 }, { inventoryId: 'i_vanilla', qty: 3, unit: 'liter', unitPrice: 8000 }], 0, 'بانتظار التأكيد'),
    P('s6', 2, 'cancelled', [{ inventoryId: 'i_mint', qty: 2, unit: 'kg', unitPrice: 5000 }], 0, 'تم الإلغاء لتأخر المورد'),
  ];
  st.purchases.filter((p) => p.status === 'received').forEach((p) => p.lines.forEach((l) => mv(l.inventoryId, 'receive', toBase(l.qty, l.unit, st.inventory.find((i) => i.id === l.inventoryId)), `استلام ${p.no}`, p.receivedAt)));
  mv('i_milk', 'waste', -1500, 'انتهاء صلاحية', ago(2 * 86400000));
  mv('i_mint', 'waste', -150, 'ذبول', ago(86400000));
  mv('i_sugar', 'adjust', -400, 'تسوية بعد الجرد', ago(5 * 86400000));
  mv('i_cocoa', 'count', 0, 'جرد شهري (لا فرق)', ago(7 * 86400000));
  st.movements.sort((a, b) => b.at.localeCompare(a.at));

  // ----- المصروفات -----
  const ex = (name, category, amountEgp, daysAgo, method, note = '') => {
    const at = atDay(daysAgo, 11);
    return { id: uid('ex'), name, category, amount: amountEgp * 100, date: dayKey(at), at: at.toISOString(), method, note, cancelled: false };
  };
  st.expenses = [
    ex('إيجار المحل', 'إيجار', 12000, 28, 'other', 'الشهر الحالي'),
    ex('فاتورة الكهرباء', 'كهرباء ومياه', 1850, 20, 'other'),
    ex('رواتب العاملين', 'رواتب', 21000, 15, 'other'),
    ex('صيانة ماكينة القهوة', 'صيانة', 750, 12, 'cash'),
    ex('مستلزمات تنظيف', 'مستلزمات', 320, 9, 'cash'),
    ex('إعلان على السوشيال ميديا', 'تسويق', 1200, 8, 'card'),
    ex('أكواب وأغطية', 'مستلزمات', 1450, 6, 'cash'),
    ex('انترنت', 'اشتراكات', 450, 5, 'other'),
    ex('بقشيش توصيل', 'أخرى', 80, 3, 'cash'),
    ex('مستلزمات نظافة', 'مستلزمات', 210, 1, 'cash'),
  ];

  // ----- الورديات والخزنة -----
  for (let d = 6; d >= 1; d -= 1) {
    const sh = { id: `sh_${d}`, cashier: d % 2 ? 'سارة الكاشير' : 'محمود الكاشير', openedAt: atDay(d, 8, 0).toISOString(), openingCash: 50000, closedAt: atDay(d, 23, 45).toISOString(), note: '' };
    if (d % 2 === 0) st.cashMovements.push({ id: uid('cm'), shiftId: sh.id, type: 'deposit', amount: 20000, reason: 'إيداع من الإدارة', at: atDay(d, 12, 0).toISOString() });
    if (d % 3 === 0) st.cashMovements.push({ id: uid('cm'), shiftId: sh.id, type: 'withdrawal', amount: 15000, reason: 'مشتريات طارئة', at: atDay(d, 18, 0).toISOString() });
    st.shifts.push(sh);
  }
  const diffs = { 6: 0, 5: -500, 4: 1000, 3: 0, 2: -200, 1: 0 };
  st.shifts.forEach((sh) => {
    const s = shiftSummary(st, sh);
    const d = Number(sh.id.split('_')[1]);
    sh.expectedCash = s.expected;
    sh.countedCash = s.expected + diffs[d];
    sh.difference = diffs[d];
  });
  const open = Math.min(atDay(0, 8, 30).getTime(), now - 40 * 60000);
  st.shifts.push({ id: 'sh_open', cashier: 'سارة الكاشير', openedAt: new Date(open).toISOString(), openingCash: 50000, closedAt: undefined });
  st.cashMovements.push({ id: uid('cm'), shiftId: 'sh_open', type: 'deposit', amount: 10000, reason: 'فكة إضافية', at: ago(30 * 60000) });
  st.categories = clone(MIROVA_MENU.categories); st.products = MIROVA_MENU.products(); st.recipes = {}; st.migrated = Object.assign(st.migrated || {}, { mirova: true, mirova2: true });

  return st;
}

// ===== 20-store.js =====
// ---------------------------------------------------------------------------
// الحالة (Store): مصدر واحد للحقيقة + حفظ تجريبي في localStorage.
// هذا الجزء هو ما سيُستبدل لاحقًا باستدعاءات API حقيقية.
// ---------------------------------------------------------------------------
let S = null; // الحالة الحالية
let persistTimer = null;
const listeners = [];

let FRESH_BOOT = false; // لا توجد بيانات في التخزين الرئيسي
let idbReady = false;
let idbTimer = null;
function idbOpen() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no idb'));
    const r = window.indexedDB.open('hyperone-mirror', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbPut(key, val) {
  return idbOpen().then((db) => new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }));
}
function idbGet(key) {
  return idbOpen().then((db) => new Promise((res, rej) => { const rq = db.transaction('kv').objectStore('kv').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }));
}
function idbMirrorSoon() {
  clearTimeout(idbTimer);
  idbTimer = setTimeout(() => { if (S && idbReady && !RECOVERY && !isMenuRoute()) idbPut('state', JSON.stringify(S)).catch(() => { /* ignore */ }); }, 500);
}
let RECOVERY = null; // يُضبط عند وجود بيانات محفوظة غير صالحة
function loadState() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(LS_KEY);
    if (raw === null) FRESH_BOOT = true;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === STATE_VERSION && Array.isArray(parsed.orders) && parsed.settings) return parsed;
    }
  } catch (e) {
    /* تالف */
  }
  if (raw) {
    // لا نكتب فوق البيانات غير الصالحة قبل حفظ نسخة منها
    try { window.localStorage.setItem(LS_KEY + '.corrupt', raw); } catch (e) { /* ignore */ }
    RECOVERY = { raw };
  }
  return null;
}

function persistNow() {
  if (RECOVERY || isMenuRoute()) return true; // شاشة المنيو للقراءة فقط // لا نكتب فوق البيانات التالفة قبل قرار المستخدم
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(S)); if (idbReady) idbMirrorSoon(); return true; }
  catch (e) { console.error(e); return false; }
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 150);
}

function audit(kind, detail) {
  try {
    if (!Array.isArray(S.auditLog)) S.auditLog = [];
    S.auditLog.unshift({ at: new Date().toISOString(), by: (currentUser() || {}).name || '—', kind, detail });
    if (S.auditLog.length > 500) S.auditLog.length = 500;
    persistSoon();
  } catch (e) { /* ignore */ }
}

function migrateState(st) {
  st.migrated = st.migrated || {};
  if (!st.migrated.noton) { // إلغاء وحدة الطن (إلا لو مستخدمة في وصفة أو فاتورة شراء)
    const used = JSON.stringify([st.recipes || {}, st.purchases || [], st.inventory || []]).includes('"ton"');
    if (Array.isArray(st.uoms) && !used) st.uoms = st.uoms.filter((u) => u.id !== 'ton');
    st.migrated.noton = true;
  }
  const defs = defaultUoms();
  if (!Array.isArray(st.uoms)) st.uoms = defs;
  else defs.forEach((d) => { if (!st.uoms.some((u) => u.id === d.id)) st.uoms.push(d); });
  setUoms(st.uoms);
  if (!Array.isArray(st.attendance)) st.attendance = [];
  if (!Array.isArray(st.auditLog)) st.auditLog = [];
  if (!st.settings.business.mode) st.settings.business.mode = 'cafe';
  if (!st.migrated.attendance) {
    st.roles.forEach((r) => {
      if (r.permissions.includes('*')) return;
      if (!r.permissions.includes('page.attendance')) r.permissions.push('page.attendance');
      if (r.id === 'r_manager' && !r.permissions.includes('attendance.manage')) r.permissions.push('attendance.manage');
    });
    st.migrated.attendance = true;
  }
  if (!st.migrated.mirova2) { // استبدال الأصناف والأقسام بمنيو ميروفا الجديد (مرة واحدة)
    st.categories = clone(MIROVA_MENU.categories);
    st.products = MIROVA_MENU.products();
    st.recipes = {};
    st.migrated.mirova = true; st.migrated.mirova2 = true;
  }
  if (!st.migrated.noextras) { // إزالة قسم الإضافات وأصنافه ومسمى النظام القديم (مرة واحدة)
    st.categories = st.categories.filter((c) => c.id !== 'c_extra');
    st.products = st.products.filter((p) => p.categoryId !== 'c_extra');
    if (st.settings.business.name === 'كوفي') st.settings.business.name = 'كوفي';
    if (/Hyper One/.test(st.settings.invoice.header)) st.settings.invoice.header = st.settings.invoice.header.replace('كوفي', 'كوفي');
    st.migrated.noextras = true;
  }
  if (!st.migrated.cancel) {
    const m = st.roles.find((r) => r.id === 'r_manager');
    if (m && !m.permissions.includes('orders.cancel')) m.permissions.push('orders.cancel');
    st.migrated.cancel = true;
  }
}

function initState() {
  S = loadState() || buildSeed();
  if (!S.settings.notify) S.settings.notify = { enabled: false, botToken: '', chatId: '' };
  migrateState(S);
  applyTheme();
  persistNow();
}

function resetDemo() {
  const auth = S.auth;
  S = buildSeed();
  S.auth = auth;
  applyTheme();
  persistNow();
}

/** يغيّر الحالة داخل fn ثم يحفظ ويعيد الرسم */
function commit(fn, opts = {}) {
  fn(S);
  persistSoon();
  if (!opts.silent) render();
}

function isMarket() { return !!(S && S.settings.business.mode === 'market'); }
function applyMode() { ORDER_TYPES.takeaway = isMarket() ? 'بيع مباشر' : 'تيك أواي'; }
function applyTheme() {
  applyMode();
  document.documentElement.setAttribute('data-theme', S.settings.appearance.theme);
}

// ----- المستخدم الحالي والصلاحيات (محاكاة واجهة فقط) -----
function currentUser() {
  return S.users.find((u) => u.id === S.auth.userId && u.active) || null;
}
function currentRole() {
  const u = currentUser();
  return u ? S.roles.find((r) => r.id === u.roleId) : null;
}
function userPerms(u) {
  if (!u) return null;
  if (Array.isArray(u.perms)) return u.perms; // صلاحيات مخصصة للمستخدم تتقدم على صلاحيات الدور
  const r = S.roles.find((x) => x.id === u.roleId);
  return r ? r.permissions : null;
}
function can(key) {
  if (key === 'page.tax') key = 'page.settings'; // الضريبة تتبع صلاحية الإعدادات
  return hasPerm(userPerms(currentUser()), key);
}

const DEMO_PASSWORDS = { admin: 'admin123', manager: 'manager123', cashier: 'cashier123', cashier2: 'cashier123', store: 'store123' };

function hashPw(pw, salt) { // تشفير بسيط (cyrb53) — ليس حماية حقيقية
  const str = `${salt}|${pw}`;
  let h1 = 0xdeadbeef ^ salt.length;
  let h2 = 0x41c6ce57 ^ salt.length;
  for (let i = 0; i < str.length; i += 1) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
function checkPassword(u, pw) { return u.pwHash ? hashPw(pw, u.pwSalt) === u.pwHash : DEMO_PASSWORDS[u.username] === pw; }
function setPassword(u, pw) { u.pwSalt = uid('s'); u.pwHash = hashPw(pw, u.pwSalt); }

function login(username, password) {
  const u = S.users.find((x) => x.username === username.trim().toLowerCase());
  if (!u || !u.active || !checkPassword(u, password)) return false;
  commit((s) => { s.auth.userId = u.id; u.lastActive = new Date().toISOString(); }, { silent: true });
  return true;
}
function logout() {
  commit((s) => { s.auth.userId = null; });
}

// ----- المخزون -----
function invById(id) { return S.inventory.find((i) => i.id === id); }

function addMovement(s, inventoryId, type, delta, reason, ref = '', orig = null) {
  const it = s.inventory.find((x) => x.id === inventoryId);
  const after = it ? it.qty : null;
  s.movements.unshift({ id: uid('mv'), inventoryId, type, delta, reason, at: new Date().toISOString(), ref, orig, before: after == null ? null : Math.round((after - delta) * 1000) / 1000, after, by: (currentUser() || {}).name || '' });
}

/** خصم مكونات الوصفة عند إتمام البيع مرة واحدة فقط (يُنفَّذ داخل commit) */
function deductForOrder(s, order) {
  const need = requirementsFor(order.items, s.recipes, s.inventory);
  need.forEach((qty, id) => {
    const it = s.inventory.find((x) => x.id === id);
    it.qty = Math.round((it.qty - qty) * 1000) / 1000;
    addMovement(s, id, 'sale', -qty, `بيع ${order.no}`, order.id);
  });
  order.items.forEach((it) => {
    const p = s.products.find((x) => x.id === it.productId);
    if (p && p.stockMode === 'direct') p.stockQty = (p.stockQty || 0) - (it.weightG ? it.weightG * it.qty : it.qty);
  });
}

function shortages(order) {
  const need = requirementsFor(order.items, S.recipes, S.inventory);
  const out = [];
  need.forEach((qty, id) => {
    const it = invById(id);
    if (it && it.qty < qty) out.push({ name: it.name, need: qty, have: it.qty, unit: it.baseUnit });
  });
  const direct = new Map();
  order.items.forEach((it) => {
    const p = S.products.find((x) => x.id === it.productId);
    if (p && p.stockMode === 'direct') direct.set(p.id, (direct.get(p.id) || 0) + (it.weightG ? it.weightG * it.qty : it.qty));
  });
  direct.forEach((q, id) => {
    const p = S.products.find((x) => x.id === id);
    if ((p.stockQty || 0) < q) out.push({ name: p.name, need: q, have: p.stockQty || 0, unit: isWeight(p) ? 'g' : 'piece' });
  });
  return out;
}

// ----- السلة -----
function cartTotals() {
  const c = S.cart;
  const discount = c.discount && c.discount.type ? { type: c.discount.type, value: c.discount.value } : null;
  const fee = cartFee(c);
  const add = (t) => { t.deliveryFee = fee; t.total += fee; return t; };
  try {
    return { ok: true, t: add(priceCart(c.items, discount, S.settings)) };
  } catch (e) {
    return { ok: false, error: e.message, t: add(priceCart(c.items, null, S.settings)) };
  }
}

function addToCart(product, options, qty = 1) {
  commit((s) => {
    const sig = optionsSignature(options);
    const ex = s.cart.items.find((i) => i.productId === product.id && optionsSignature(i.options) === sig && !i.note);
    if (ex) ex.qty += qty;
    else s.cart.items.push(cartItemFrom(product, options, qty, ''));
  });
}

function sentQtyOf(key) {
  const o = S.cart.orderId && S.orders.find((x) => x.id === S.cart.orderId);
  const it = o && o.items.find((i) => i.key === key);
  return it ? it.kitchenQty || 0 : 0;
}
function managerApproval(title, cb) {
  openModal({
    title, size: 'sm',
    body: `<div class="col"><div class="hint">الصنف/الطلب أُرسل للمطبخ. يلزم اعتماد المدير: اطلب منه إدخال بياناته (محاكاة واجهة وليست حماية حقيقية).</div>${field('اسم مستخدم المدير', '<input class="input" name="mu" autocapitalize="off">')}${field('كلمة مرور المدير', '<input class="input" type="password" name="mp">')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>اعتماد</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const mgr = S.users.find((u) => u.active && u.username === d.mu.trim().toLowerCase() && hasPerm(userPerms(u), 'orders.cancel') && checkPassword(u, d.mp));
        if (!mgr) return markInvalid(el, 'mp', 'بيانات المدير غير صحيحة');
        close();
        cb(mgr);
      });
    },
  });
}
function requestCancel(o, reason) {
  const run = (by) => { cancelOrder(o.id, reason, by); audit('إلغاء طلب', `${o.no}${by ? ` — اعتماد: ${by}` : ''}`); toast('تم إلغاء الطلب', 'ok'); };
  const sent = o.items.some((i) => i.kitchenQty > 0);
  if (sent && !can('orders.cancel')) managerApproval('إلغاء طلب أُرسل للمطبخ', (m) => run(m.name));
  else run(sent ? currentUser().name : '');
}
function setQty(key, delta) {
  const cur = S.cart.items.find((x) => x.key === key);
  if (cur && delta < 0 && cur.qty + delta < sentQtyOf(key) && !can('orders.cancel')) return managerApproval('تقليل صنف أُرسل للمطبخ', () => setQtyDo(key, delta));
  return setQtyDo(key, delta);
}
function setQtyDo(key, delta) {
  commit((s) => {
    const i = s.cart.items.find((x) => x.key === key);
    if (!i) return;
    i.qty += delta;
    if (i.qty <= 0) s.cart.items = s.cart.items.filter((x) => x.key !== key);
    if (!s.cart.items.length) s.cart.discount = { type: null, value: 0, reason: '', approvedBy: '' };
  });
}

function removeFromCart(key) {
  if (sentQtyOf(key) > 0 && !can('orders.cancel')) return managerApproval('حذف صنف أُرسل للمطبخ', () => removeFromCartDo(key));
  return removeFromCartDo(key);
}
function removeFromCartDo(key) {
  commit((s) => { s.cart.items = s.cart.items.filter((x) => x.key !== key); });
}

function clearCart() {
  commit((s) => { s.cart = emptyCart(); });
}

/** حفظ الطلب الحالي كطلب قيد التنفيذ (أو تعليقه) */
function saveCartAsOrder(status = 'pending') {
  const c = S.cart;
  if (!c.items.length) return { ok: false, error: 'الفاتورة فارغة' };
  if (c.type === 'dine_in' && !c.tableId) return { ok: false, error: 'اختر الطاولة أولًا لطلبات الصالة' };
  { const de = deliveryError(c); if (de) return { ok: false, error: de }; }
  if (c.type === 'dine_in') {
    const ex = activeOrderForTable(S, c.tableId);
    if (ex && ex.id !== c.orderId) return { ok: false, error: `الطاولة ${fmtInt(c.tableId)} عليها طلب مفتوح (${ex.no}). افتح الطلب الحالي بدل الكتابة فوقه.` };
  }
  let saved = null;
  commit((s) => {
    const cart = s.cart;
    if (cart.orderId) {
      const o = s.orders.find((x) => x.id === cart.orderId);
      const comp = composeOrder(s, cart, o.items);
      const t = comp.totals;
      Object.assign(o, {
        type: cart.type, tableId: cart.type === 'dine_in' ? cart.tableId : null, customerId: cart.customerId, note: cart.note,
        items: comp.items, subtotal: t.subtotal, discountAmount: t.discountAmount, taxAmount: t.taxAmount, netSales: t.netSales,
        total: t.total, deliveryFee: t.deliveryFee || 0, delivery: cart.type === 'delivery' ? clone(cart.delivery || null) : null, cogs: comp.cogs, status, updatedAt: new Date().toISOString(),
        discount: { type: t.discountType, value: t.discountValue, reason: cart.discount.reason, approvedBy: cart.discount.approvedBy },
      });
      o.awaitingPayment = false;
      saved = o;
    } else {
      const o = makeOrder(s, cart, { status, cashier: currentUser().name });
      s.orders.push(o);
      saved = o;
    }
    s.cart = emptyCart();
  });
  return { ok: true, order: saved };
}

function openOrderInCart(orderId) {
  const o = S.orders.find((x) => x.id === orderId);
  if (!o || (o.status !== 'pending' && o.status !== 'held')) return false;
  commit((s) => {
    s.cart = {
      items: o.items.map((i) => ({ weightG: i.weightG || 0, pricePerKg: i.pricePerKg || 0, key: i.key, productId: i.productId, name: i.name, emoji: i.emoji, tone: i.tone, image: i.image || '', basePrice: i.basePrice, options: clone(i.options), qty: i.qty, note: i.note, taxExempt: i.taxExempt })),
      type: o.type, tableId: o.tableId, note: o.note, customerId: o.customerId, orderId: o.id,
      delivery: o.delivery ? clone(o.delivery) : { name: '', phone: '', address: '', fee: 0 },
      discount: { type: o.discount.type, value: o.discount.value, reason: o.discount.reason || '', approvedBy: o.discount.approvedBy || '' },
    };
  });
  return true;
}

/** الإرسال للمطبخ: يعلّم الكميات المرسلة ويعيد الأصناف الجديدة فقط للتذكرة */
function sendToKitchen() {
  const c = S.cart;
  if (!c.items.length) return { ok: false, error: 'الفاتورة فارغة' };
  if (c.type === 'dine_in' && !c.tableId) return { ok: false, error: 'اختر الطاولة أولًا' };
  const r = saveCartAsOrder('pending');
  if (!r.ok) return r;
  const o = r.order;
  const fresh = [];
  commit((s) => {
    const ord = s.orders.find((x) => x.id === o.id);
    ord.items.forEach((i) => {
      const diff = i.qty - i.kitchenQty;
      if (diff > 0) fresh.push({ ...clone(i), qty: diff });
      i.kitchenQty = i.qty;
    });
  }, { silent: true });
  openOrderInCart(o.id); // يبقى الطلب مفتوحًا في الكاشير بعد الإرسال للمطبخ
  return { ok: true, order: S.orders.find((x) => x.id === o.id), fresh };
}

/** إتمام البيع (محاكاة): يخصم المخزون مرة واحدة ويسجل المدفوعات */
const JOURNAL_KEY = 'hyperone.sale.journal';
let saleLock = false;
function completeSale(payments, orderIdForPay) {
  if (saleLock) return { ok: false, error: 'عملية بيع قيد التنفيذ' };
  saleLock = true;
  const snapshot = clone(S);
  const clearJ = () => { try { window.localStorage.removeItem(JOURNAL_KEY); } catch (e) { /* ignore */ } };
  try { window.localStorage.setItem(JOURNAL_KEY, JSON.stringify({ at: new Date().toISOString() })); } catch (e) { /* ignore */ }
  try {
    const r = completeSaleInner(payments, orderIdForPay);
    if (!r.ok) { clearJ(); return r; }
    if (!persistNow()) {
      S = snapshot;
      audit('خطأ حفظ', 'فشل حفظ عملية بيع وتم التراجع عنها');
      clearJ();
      render();
      return { ok: false, error: 'فشل حفظ العملية (التخزين ممتلئ أو غير متاح). لم يُتم البيع ولم يُخصم المخزون. نزّل نسخة احتياطية.' };
    }
    clearJ();
    return r;
  } finally { saleLock = false; }
}

function completeSaleInner(payments, orderIdForPay) {
  const c = S.cart;
  const hasCart = c.items.length > 0;
  if (!hasCart) return { ok: false, error: 'الفاتورة فارغة' };
  if (!currentShift()) return { ok: false, error: 'لا توجد وردية مفتوحة. افتح وردية من شاشة الخزنة والورديات.' };
  if (c.type === 'dine_in' && !c.tableId) return { ok: false, error: 'اختر الطاولة لطلب الصالة' };
  { const de = deliveryError(c); if (de) return { ok: false, error: de }; }
  const tot = cartTotals();
  if (!tot.ok) return { ok: false, error: tot.error };
  let alloc;
  try {
    alloc = allocatePayments(tot.t.total, payments, { allowPartial: false });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // سياسة نقص المخزون
  const comp = composeOrder(S, c, c.orderId ? (S.orders.find((x) => x.id === c.orderId) || {}).items || [] : []);
  const probe = { items: comp.items };
  const short = shortages(probe);
  if (short.length && S.settings.inventory.insufficientStock === 'block') {
    return { ok: false, error: `المخزون غير كافٍ: ${short.map((x) => x.name).join('، ')}` };
  }
  if (c.type === 'dine_in') {
    const ex = activeOrderForTable(S, c.tableId);
    if (ex && ex.id !== c.orderId) return { ok: false, error: `الطاولة ${fmtInt(c.tableId)} عليها طلب مفتوح آخر` };
  }
  let done = null;
  commit((s) => {
    const cart = s.cart;
    let o;
    if (cart.orderId) {
      o = s.orders.find((x) => x.id === cart.orderId);
      const cc = composeOrder(s, cart, o.items);
      const t = cc.totals;
      Object.assign(o, { type: cart.type, tableId: cart.type === 'dine_in' ? cart.tableId : null, customerId: cart.customerId, note: cart.note, items: cc.items, subtotal: t.subtotal, discountAmount: t.discountAmount, taxAmount: t.taxAmount, netSales: t.netSales, total: t.total, deliveryFee: t.deliveryFee || 0, delivery: cart.type === 'delivery' ? clone(cart.delivery || null) : null, cogs: cc.cogs, discount: { type: t.discountType, value: t.discountValue, reason: cart.discount.reason, approvedBy: cart.discount.approvedBy } });
    } else {
      o = makeOrder(s, cart, { status: 'pending', cashier: currentUser().name });
      s.orders.push(o);
    }
    o.status = 'completed';
    o.awaitingPayment = false;
    o.payments = alloc.lines;
    o.paid = alloc.paid;
    o.change = alloc.change;
    o.paidAt = new Date().toISOString();
    o.updatedAt = o.paidAt;
    o.items.forEach((i) => { i.kitchenQty = i.qty; });
    deductForOrder(s, o); // خصم المكونات مرة واحدة (الطلب كان غير مكتمل قبل هذه اللحظة)
    audit('بيع', `${o.no} — ${fmtMoney(o.total)}`);
    s.cart = emptyCart();
    done = o;
  });
  return { ok: true, order: done };
}

function cancelOrder(orderId, reason, approvedBy) {
  commit((s) => {
    const o = s.orders.find((x) => x.id === orderId);
    if (o && (o.status === 'pending' || o.status === 'held')) { o.status = 'cancelled'; o.cancelledBy = currentUser().name; o.cancelApprovedBy = approvedBy || ''; o.note = (o.note ? o.note + ' | ' : '') + 'إلغاء: ' + (reason || '—'); o.updatedAt = new Date().toISOString(); }
    if (s.cart.orderId === orderId) s.cart = emptyCart();
  });
}

function setAwaitingPayment(orderId, v) {
  commit((s) => { const o = s.orders.find((x) => x.id === orderId); if (o) o.awaitingPayment = v; });
}

// ----- الورديات والخزنة -----
function currentShift() { return S.shifts.find((x) => !x.closedAt) || null; }

// ----- المرتجعات (محاكاة؛ التحقق الحقيقي يجب أن يتم في الباك إند لاحقًا) -----
function createRefund({ orderId, lines, method, reason }) {
  if (!can('refunds.execute')) return { ok: false, error: 'غير مصرّح: المرتجعات للمدير فقط (محاكاة واجهة)' };
  if (S.settings.refunds.requireReason && !reason.trim()) return { ok: false, error: 'سبب الاسترجاع مطلوب' };
  const o = S.orders.find((x) => x.id === orderId);
  if (!o || o.status !== 'completed') return { ok: false, error: 'الفاتورة غير مؤهلة للاسترجاع' };
  if (!lines.length) return { ok: false, error: 'اختر صنفًا واحدًا على الأقل' };
  let total = 0;
  const rows = [];
  try {
    for (const l of lines) {
      const it = o.items[l.itemIndex];
      if (!it) throw new MoneyError('صنف غير موجود');
      const amt = refundItemAmount(it, l.qty);
      rows.push({ itemIndex: l.itemIndex, name: it.name, qty: l.qty, amount: amt });
      total += amt;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  let rf = null;
  commit((s) => {
    const ord = s.orders.find((x) => x.id === orderId);
    rows.forEach((r) => {
      const it = ord.items[r.itemIndex];
      it.refundedQty += r.qty;
      it.refundedAmount += r.amount;
      if (s.settings.inventory.restoreOnRefund) {
        const need = requirementsFor([{ productId: it.productId, qty: r.qty }], s.recipes, s.inventory);
        need.forEach((q, id) => { const inv = s.inventory.find((x) => x.id === id); inv.qty = Math.round((inv.qty + q) * 1000) / 1000; addMovement(s, id, 'refund_restore', q, 'استرجاع (محاكاة)', ord.id); });
        { const dp = s.products.find((x) => x.id === it.productId); if (dp && dp.stockMode === 'direct') dp.stockQty = (dp.stockQty || 0) + (it.weightG ? it.weightG * r.qty : r.qty); }
      }
    });
    ord.refundedAmount += total;
    rf = { id: uid('rf'), ref: nextNo(s, 'refund'), orderId, orderNo: ord.no, amount: total, method, reason: reason.trim(), items: rows, at: new Date().toISOString(), by: currentUser().name, note: '' };
    s.refunds.push(rf);
    audit('مرتجع', `${rf.ref} على ${rf.orderNo} — ${fmtMoney(rf.amount)}`);
  });
  return { ok: true, refund: rf };
}

// ----- مساعدات عامة للعرض -----
function customerName(id) { const c = S.customers.find((x) => x.id === id); return c ? c.name : '—'; }
function supplierName(id) { const c = S.suppliers.find((x) => x.id === id); return c ? c.name : '—'; }
function categoryName(id) { const c = S.categories.find((x) => x.id === id); return c ? c.name : '—'; }
function money(p) { return fmtMoney(p); }
function dt(iso) { return fmtDateTime(iso, S.settings.regional.dateFormat, S.settings.regional.timeFormat === '12'); }
function dOnly(iso) { return fmtDate(iso, S.settings.regional.dateFormat); }
function tOnly(iso) { return fmtTime(iso, S.settings.regional.timeFormat === '12'); }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== 30-ui.js =====
// ---------------------------------------------------------------------------
// مكوّنات الواجهة المشتركة: أيقونات، نوافذ، إشعارات، جداول، رسوم SVG، إيصالات
// ---------------------------------------------------------------------------
const ICONS = {
  tax: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  cashier: '<rect x="4" y="3" width="16" height="6" rx="1"/><path d="M6 9v12h12V9"/><path d="M9 13h6M9 17h6"/>',
  tables: '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  products: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  categories: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4z"/><circle cx="16.5" cy="16.5" r="3.5"/>',
  recipes: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/>',
  inventory: '<path d="M3 8l9-5 9 5v9l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v9"/>',
  purchases: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11L21 7H6"/>',
  suppliers: '<path d="M1 6h13v10H1zM14 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  expenses: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v.01M18 15v.01"/>',
  customers: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M17 5a3.5 3.5 0 010 7M19 14c2 .8 3 2.6 3 5"/>',
  users: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  cashbox: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 11h18M12 15h.01"/><path d="M8 7V5h8v2"/>',
  refunds: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.5"/><path d="M3 4v5h5"/>',
  printers: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  backup: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  logout: '<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  moon: '<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  kitchen: '<path d="M6 13h12a3 3 0 003-3 5 5 0 00-5-5 4 4 0 00-8 0 5 5 0 00-5 5 3 3 0 003 3zM6 13v8h12v-8"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11L21 7H6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
};
function icon(name, size) {
  const p = ICONS[name] || ICONS.info;
  const s = size ? ` width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 24 24"${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// ----- إشعارات -----
function toast(msg, kind = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5200 : 3200);
}

// ----- نوافذ منبثقة -----
let modalSeq = 0;
const modalStack = [];

/**
 * يفتح نافذة. opts: {title, body (html), footer (html), size, onMount(el, close)}
 * يعيد دالة الإغلاق.
 */
function openModal(opts) {
  const id = `m${++modalSeq}`;
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.dataset.mid = id;
  layer.innerHTML = `
    <div class="modal ${opts.size || ''}" role="dialog" aria-modal="true">
      <div class="modal-h"><span>${opts.title || ''}</span><button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="إغلاق">${icon('x')}</button></div>
      <div class="modal-b">${opts.body || ''}</div>
      ${opts.footer ? `<div class="modal-f">${opts.footer}</div>` : ''}
    </div>`;
  document.getElementById('modal-root').appendChild(layer);
  const close = () => {
    const i = modalStack.findIndex((m) => m.id === id);
    if (i >= 0) modalStack.splice(i, 1);
    layer.remove();
    if (opts.onClose) opts.onClose();
  };
  layer.addEventListener('mousedown', (e) => { if (e.target === layer && !opts.persistent) close(); });
  layer.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  modalStack.push({ id, close });
  if (opts.onMount) opts.onMount(layer, close);
  const first = layer.querySelector('input:not([type=checkbox]):not([type=radio]),select,textarea');
  if (first && !opts.noFocus) setTimeout(() => first.focus(), 30);
  return close;
}

function confirmDialog({ title = 'تأكيد', message, confirmText = 'تأكيد', danger = false, onConfirm }) {
  openModal({
    title, size: 'sm', body: `<p style="margin:0;line-height:1.8">${message}</p>`,
    footer: `<button class="btn" data-close>إلغاء</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmText}</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => { close(); onConfirm(); });
    },
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].close();
});

// ----- نماذج: قراءة وتحقق -----
function formData(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  });
  return out;
}
function markInvalid(root, name, msg) {
  const el = root.querySelector(`[name="${name}"]`);
  if (!el) return;
  el.classList.add('invalid');
  let e = el.parentElement.querySelector('.err-t');
  if (!e) { e = document.createElement('div'); e.className = 'err-t'; el.parentElement.appendChild(e); }
  e.textContent = msg;
}
function clearInvalid(root) {
  root.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
  root.querySelectorAll('.err-t').forEach((x) => (x.textContent = ''));
}
function field(label, inner, cls = '') {
  return `<div class="field ${cls}"><label>${label}</label>${inner}</div>`;
}
function options(list, selected, valueKey = 'id', labelKey = 'name') {
  return list.map((o) => `<option value="${esc(o[valueKey])}" ${String(o[valueKey]) === String(selected) ? 'selected' : ''}>${esc(o[labelKey])}</option>`).join('');
}
function badge(text, kind = 'gray') { return `<span class="badge b-${kind}">${text}</span>`; }
function emptyState(msg, emoji = '🗂️') { return `<div class="empty"><div class="big">${emoji}</div>${msg}</div>`; }
function demoNote(text) { return `<div class="demo-note">⚠️ ${text}</div>`; }
function pageHead(title, actions = '') { return `<div class="page-head"><h2>${title}</h2><div class="row wrap">${actions}</div></div>`; }
function statCard(label, value, tone, ic, sub = '') {
  return `<div class="stat"><div class="ico t-${tone}">${icon(ic)}</div><div class="grow"><div class="lbl">${label}</div><div class="val num">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
}
function thumbStyle(p) { return p.image ? `style="background-image:url('${esc(p.image)}')"` : ''; }

// ----- جداول تفاعلية (بحث/ترتيب/ترقيم) -----
const tableStates = {};
/**
 * cfg: {id, rows, columns:[{key,label,render(row),sort(row),sortable}], search(row,q), pageSize, filtersHtml, rowClass(row), onAction(name,row)}
 * يعيد HTML؛ يجب استدعاء bindTable بعد الإدراج.
 */
function dataTable(cfg) {
  const stt = (tableStates[cfg.id] = tableStates[cfg.id] || { q: '', sort: null, dir: 1, page: 1 });
  let rows = cfg.rows.slice();
  if (stt.q && cfg.search) { const q = stt.q.toLowerCase(); rows = rows.filter((r) => cfg.search(r).toLowerCase().includes(q)); }
  if (stt.sort != null) {
    const col = cfg.columns[stt.sort];
    if (col && col.sort) rows.sort((a, b) => { const x = col.sort(a); const y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * stt.dir; });
  }
  const size = cfg.pageSize || 10;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (stt.page > pages) stt.page = pages;
  const slice = rows.slice((stt.page - 1) * size, stt.page * size);
  const head = cfg.columns.map((c, i) => `<th class="${c.sort ? 'sortable' : ''}" data-sort="${i}">${c.label}${stt.sort === i ? (stt.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const body = slice.length
    ? slice.map((r, ri) => `<tr class="${cfg.rowClass ? cfg.rowClass(r) : ''}" data-ri="${rows.indexOf(r)}">${cfg.columns.map((c) => `<td>${c.render(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cfg.columns.length}">${emptyState(cfg.empty || 'لا توجد نتائج')}</td></tr>`;
  tableRegistry[cfg.id] = { cfg, rows };
  return `<div class="card" data-tbl="${cfg.id}">
    <div class="tbl-tools">
      ${cfg.search ? `<div class="input-ico grow" style="max-width:320px">${icon('search')}<input class="input" data-tsearch placeholder="بحث..." value="${esc(stt.q)}"></div>` : ''}
      ${cfg.filtersHtml || ''}
      <span class="grow"></span>
      ${cfg.toolsHtml || ''}
      <span class="muted sm">${fmtInt(rows.length)} نتيجة</span>
    </div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pages > 1 ? `<div class="pager"><span>صفحة ${fmtInt(stt.page)} من ${fmtInt(pages)}</span><div class="row"><button class="btn btn-sm" data-pg="prev" ${stt.page <= 1 ? 'disabled' : ''}>السابق</button><button class="btn btn-sm" data-pg="next" ${stt.page >= pages ? 'disabled' : ''}>التالي</button></div></div>` : ''}
  </div>`;
}
const tableRegistry = {};
function bindTable(root, id, onAction) {
  const el = root.querySelector(`[data-tbl="${id}"]`);
  if (!el) return;
  const stt = tableStates[id];
  const reg = tableRegistry[id];
  const searchEl = el.querySelector('[data-tsearch]');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      stt.q = searchEl.value; stt.page = 1;
      const pos = searchEl.selectionStart;
      render();
      const again = document.querySelector(`[data-tbl="${id}"] [data-tsearch]`);
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
    });
  }
  el.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const i = Number(th.dataset.sort);
    if (!reg.cfg.columns[i].sort) return;
    if (stt.sort === i) stt.dir *= -1; else { stt.sort = i; stt.dir = 1; }
    render();
  }));
  el.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { stt.page += b.dataset.pg === 'next' ? 1 : -1; render(); }));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const tr = b.closest('tr');
    const row = reg.rows[Number(tr.dataset.ri)];
    onAction(b.dataset.act, row, b);
  }));
}
function tblSelectFilter(id, key, label, list) {
  const stt = (tableStates[id] = tableStates[id] || { q: '', sort: null, dir: 1, page: 1 });
  stt.f = stt.f || {};
  return `<select class="select" style="width:auto;min-width:140px" data-tfilter="${id}:${key}"><option value="">${label}</option>${list.map(([v, l]) => `<option value="${esc(v)}" ${String(stt.f[key]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function bindFilters(root) {
  root.querySelectorAll('[data-tfilter]').forEach((sel) => sel.addEventListener('change', () => {
    const [id, key] = sel.dataset.tfilter.split(':');
    tableStates[id].f[key] = sel.value;
    tableStates[id].page = 1;
    render();
  }));
}
function tfilter(id, key) { const s = tableStates[id]; return s && s.f ? s.f[key] || '' : ''; }

// ----- رسوم SVG -----
function lineChart(points, { height = 200, color = '#1f6feb', fmt = (v) => fmtNum(v) } = {}) {
  const W = 640;
  const H = height;
  const pad = { l: 8, r: 8, t: 14, b: 26 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const x = (i) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  // RTL: نعكس المحور الأفقي ليكون الأقدم يمينًا
  const xr = (i) => W - x(i);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xr(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${xr(n - 1).toFixed(1)},${H - pad.b} L${xr(0).toFixed(1)},${H - pad.b} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => { const yy = pad.t + (1 - t) * (H - pad.t - pad.b); return `<line class="grid-l" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`; }).join('');
  const step = Math.max(1, Math.ceil(n / 8));
  const labels = points.map((p, i) => (i % step === 0 || i === n - 1 ? `<text x="${xr(i)}" y="${H - 8}" text-anchor="middle">${p.day.slice(5).replace('-', '/')}</text>` : '')).join('');
  const dots = points.map((p, i) => `<circle cx="${xr(i)}" cy="${y(p.value)}" r="3.2" fill="${color}"><title>${p.day}: ${fmt(p.value)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="مخطط المبيعات">${grid}<path d="${area}" fill="${color}" opacity="0.12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>${dots}${labels}</svg>`;
}
const PALETTE = ['#1f6feb', '#12a150', '#f59e0b', '#8b5cf6', '#e5484d', '#14b8a6', '#ec4899', '#64748b'];
function donutChart(items, { size = 150 } = {}) {
  const total = sum(items, (i) => i.value);
  if (!total) return emptyState('لا توجد بيانات', '📊');
  const r = 52;
  const c = 2 * Math.PI * r;
  let off = 0;
  const segs = items.map((it, i) => {
    const len = (it.value / total) * c;
    const s = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(it.label)}: ${fmtMoney(it.value)}</title></circle>`;
    off += len;
    return s;
  }).join('');
  const legend = items.map((it, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(it.label)} — ${fmtPct(Math.round((it.value / total) * 1000) / 10)}</span>`).join('');
  return `<div class="row wrap" style="justify-content:center;gap:16px"><svg viewBox="0 0 140 140" width="${size}" height="${size}" role="img" aria-label="توزيع">${segs}</svg><div class="legend" style="flex-direction:column;gap:6px">${legend}</div></div>`;
}
function barList(items, fmt = (v) => fmtMoney(v)) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return emptyState('لا توجد بيانات', '📊');
  return items.map((i) => `<div class="bar-row"><span class="ellipsis" title="${esc(i.label)}">${esc(i.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${(i.value / max) * 100}%"></div></div><b class="num">${fmt(i.value)}</b></div>`).join('');
}

// ----- الإيصالات (معاينة الطباعة) -----
function receiptHtml(o, opts = {}) {
  const set = S.settings;
  const w58 = (opts.paperWidth || set.invoice.paperWidth) === 58;
  const tax = o.taxSnapshot;
  const rows = o.items.map((i) => `<tr><td>${esc(i.name)}${i.weightG ? ` ${fmtQty(i.weightG / 1000)} كجم` : ` ×${fmtQty(i.qty)}`}${i.options.length ? `<div style="font-size:10.5px;color:#555">${i.options.map((x) => esc(x.name)).join('، ')}</div>` : ''}${i.note ? `<div style="font-size:10.5px">ملاحظة: ${esc(i.note)}</div>` : ''}</td><td class="e">${fmtNum(i.lineTotal)}</td></tr>`).join('');
  const pays = o.payments.map((p) => `<tr><td>${METHOD_LABEL[p.method] || p.method}</td><td class="e">${fmtNum(p.amount)}</td></tr>`).join('');
  return `<div class="paper ${w58 ? 'w58' : ''}" style="font-size:${set.invoice.fontSize}px">
    <h3>${esc(set.business.name)}</h3>
    <div class="c">${esc(set.business.branch)} — ${esc(set.business.address)}<br>${esc(set.business.phone)}</div>
    <div class="c">${esc(set.invoice.header)}</div><hr>
    <div>${opts.refund ? 'إيصال مرتجع' : opts.draft ? 'فاتورة مبدئية (غير مدفوعة)' : 'فاتورة'}: <b>${esc(o.no)}</b></div>
    <div>التاريخ: ${dt(o.paidAt || o.createdAt)}</div>
    <div>${ORDER_TYPES[o.type]}${o.tableId ? ` — طاولة ${fmtInt(o.tableId)}` : ''} | الكاشير: ${esc(o.cashier)}</div>
    ${o.delivery ? `<div>📞 ${esc(o.delivery.phone)}${o.delivery.name ? ` — ${esc(o.delivery.name)}` : ''}</div><div>📍 ${esc(o.delivery.address)}</div>` : ''}<hr>
    ${o.note ? `<div style="border:1px dashed #777;padding:3px 4px;margin:4px 0"><b>ملاحظة العميل:</b> ${esc(o.note)}</div>` : ''}
    <table>${rows}</table><hr>
    <table>
      <tr><td>المجموع الفرعي</td><td class="e">${fmtNum(o.subtotal)}</td></tr>
      ${o.discountAmount ? `<tr><td>الخصم</td><td class="e">-${fmtNum(o.discountAmount)}</td></tr>` : ''}
      ${o.deliveryFee ? `<tr><td>رسوم التوصيل</td><td class="e">${fmtNum(o.deliveryFee)}</td></tr>` : ''}
      ${tax.enabled ? `<tr><td>ضريبة ${fmtPct(tax.rateBps / 100)} ${tax.mode === 'inclusive' ? '(شاملة)' : ''}</td><td class="e">${fmtNum(o.taxAmount)}</td></tr>` : ''}
      <tr class="tot"><td>الإجمالي</td><td class="e">${fmtMoney(o.total)}</td></tr>
    </table><hr>
    ${o.payments.length ? `<table>${pays}${o.change ? `<tr><td>الباقي للعميل</td><td class="e">${fmtNum(o.change)}</td></tr>` : ''}</table><hr>` : ''}
    <div class="c">${esc(set.invoice.footer)}</div>
    <div class="demo-mark">— معاينة تجريبية: لم تُرسل إلى أي طابعة أو خادم —</div>
  </div>`;
}

function kitchenTicketHtml(o, items, opts = {}) {
  const w58 = (opts.paperWidth || (S.printers.find((p) => p.role === 'kitchen') || {}).paperWidth) === 58;
  const rows = items.map((i) => `<div style="margin:6px 0;border-bottom:1px dashed #aaa;padding-bottom:4px"><div style="font-size:14px;font-weight:800">${fmtQty(i.qty)} × ${esc(i.name)}</div>${i.options.length ? `<div>${i.options.map((x) => esc(x.name)).join(' • ')}</div>` : ''}${i.note ? `<div style="font-weight:700">⚠ ${esc(i.note)}</div>` : ''}</div>`).join('');
  return `<div class="paper ${w58 ? 'w58' : ''}">
    <div class="big">${o.tableId ? `طاولة ${fmtInt(o.tableId)}` : ORDER_TYPES[o.type]}</div>
    <div class="c">${esc(o.no)} — ${ORDER_TYPES[o.type]}</div>
    <div class="c">${dt(new Date().toISOString())}</div><hr>
    ${o.note ? `<div style="font-size:15px;font-weight:800;border:2px solid #000;padding:4px;margin-bottom:6px">⚠ ${esc(o.note)}</div>` : ''}
    ${rows || '<div class="c">لا أصناف جديدة</div>'}
    <div class="demo-mark">— تذكرة تجريبية: لا تحتوي بيانات دفع أو عملاء —</div>
  </div>`;
}

function showReceipt(o, title = 'معاينة الفاتورة') {
  openModal({
    title, size: 'sm', body: `<div class="paper-bg">${receiptHtml(o)}</div>`,
    footer: `<button class="btn" data-close>إغلاق</button><button class="btn btn-primary" data-print>${icon('print')} طباعة من المتصفح</button>`,
    onMount(el) { el.querySelector('[data-print]').addEventListener('click', () => printHtml(receiptHtml(o))); },
  });
}
function printHtml(html) {
  const root = document.getElementById('print-root');
  // عرض الورق: 58 إذا كان الإيصال w58، وإلا حسب إعدادات الفاتورة (80 افتراضيًا)
  const mm = /class="paper[^"]*\bw58\b/.test(html) ? 58 : (Number(S.settings.invoice.paperWidth) === 58 ? 58 : 80);
  let st = document.getElementById('print-page-style');
  if (!st) { st = document.createElement('style'); st.id = 'print-page-style'; document.head.appendChild(st); }
  st.textContent = `@media print { @page { size: ${mm}mm auto; margin: 0; } #print-root .paper { width: ${mm === 58 ? 48 : 72}mm !important; } }`;
  root.innerHTML = html;
  window.print();
  setTimeout(() => { root.innerHTML = ''; }, 500);
}

// ===== 40-shell.js =====
// ---------------------------------------------------------------------------
// الهيكل العام: التوجيه، القائمة الجانبية، الشريط العلوي، تسجيل الدخول
// ---------------------------------------------------------------------------
const UI = {
  menuOpen: false,
  cashier: { q: '', cat: 'all', invOpen: false },
  dash: { period: 'today' },
  reports: { period: 'week', tab: 'sales', from: '', to: '' },
  recipes: { selected: null },
  tablesView: { sel: null },
  refunds: { orderId: null, q: '' },
  settingsTab: 'business',
  supplierSel: null,
  customerSel: null,
  loginError: '',
};

const NAV = [
  { key: 'dashboard', label: 'الرئيسية', icon: 'home' },
  { key: 'cashier', label: 'الكاشير', icon: 'cashier' },
  { key: 'tables', label: 'الطاولات', icon: 'tables' },
  { key: 'orders', label: 'الطلبات', icon: 'orders' },
  { key: 'products', label: 'الأصناف', icon: 'products' },
  { key: 'categories', label: 'التصنيفات', icon: 'categories' },
  { key: 'recipes', label: 'الوصفات والتكلفة', icon: 'recipes' },
  { key: 'inventory', label: 'المخزون', icon: 'inventory' },
  { key: 'purchases', label: 'المشتريات', icon: 'purchases' },
  { key: 'suppliers', label: 'الموردون', icon: 'suppliers' },
  { key: 'expenses', label: 'المصروفات', icon: 'expenses' },
  { key: 'customers', label: 'العملاء', icon: 'customers' },
  { key: 'users', label: 'المستخدمون والصلاحيات', icon: 'users' },
  { key: 'reports', label: 'التقارير', icon: 'reports' },
  { key: 'cashbox', label: 'الخزنة والورديات', icon: 'cashbox' },
  { key: 'refunds', label: 'المرتجعات', icon: 'refunds' },
  { key: 'attendance', label: 'الحضور والغياب', icon: 'clock' },
  { key: 'printers', label: 'إعدادات الطابعات', icon: 'printers' },
  { key: 'settings', label: 'الإعدادات', icon: 'settings' },
  { key: 'tax', label: 'الضريبة', icon: 'tax' },
  { key: 'backup', label: 'النسخ الاحتياطي والاستعادة', icon: 'backup' },
];
const SHORT = { 'الحضور والغياب': 'الحضور', 'المستخدمون والصلاحيات': 'المستخدمون', 'النسخ الاحتياطي والاستعادة': 'النسخ الاحتياطي', 'الوصفات والتكلفة': 'الوصفات', 'إعدادات الطابعات': 'الطابعات', 'الخزنة والورديات': 'الخزنة' };

const PAGES = {}; // key → { render(): html, bind(root) }

function route() {
  const h = (location.hash || '#/dashboard').replace(/^#\//, '').split('?')[0];
  return NAV.some((n) => n.key === h) ? h : 'dashboard';
}
function go(key) {
  if (location.hash === `#/${key}`) render(); else location.hash = `#/${key}`;
}
window.addEventListener('hashchange', () => { UI.menuOpen = false; render(); });

function allowedNav() { return NAV.filter((n) => can(`page.${n.key}`) && !(isMarket() && n.key === 'tables')); }

function renderLogin() {
  const accounts = [['admin', 'admin123', 'مدير النظام'], ['manager', 'manager123', 'مدير'], ['cashier', 'cashier123', 'كاشير'], ['store', 'store123', 'موظف مخزون']];
  return `<div class="login"><form class="login-card" id="login-form" novalidate>
    <div class="brand"><div class="mark">${icon('cashier', 32)}</div><h1>كوفي</h1><div class="muted">نظام نقاط البيع للكافيهات والمطاعم</div></div>
    ${demoNote('وضع العرض التجريبي: تسجيل الدخول هنا محاكاة بالكامل داخل المتصفح ولا يوفّر أي حماية حقيقية. الصلاحيات الفعلية يجب أن تُفرض في الباك إند لاحقًا.')}
    <div class="col">
      ${field('اسم المستخدم', `<input class="input" name="username" autocomplete="username" autocapitalize="off" placeholder="مثال: admin" value="${esc(UI.loginUser || '')}">`)}
      ${field('كلمة المرور', `<div class="input-ico"><input class="input" type="password" name="password" autocomplete="current-password" placeholder="••••••••"><button type="button" class="btn btn-ghost btn-sm" id="pw-toggle" style="position:absolute;inset-inline-end:4px;top:4px" aria-label="إظهار/إخفاء">${icon('eye')}</button></div>`)}
      <div class="err-t" id="login-err">${esc(UI.loginError)}</div>
      <button class="btn btn-primary btn-lg btn-block" id="login-btn">تسجيل الدخول</button>
    </div>
    <div class="demo-accounts"><div class="lbl-t">حسابات العرض التجريبية (اضغط للتعبئة)</div>
      <div class="chips">${accounts.map(([u, p, l]) => `<button type="button" class="chip" data-fill="${u}|${p}">${l}</button>`).join('')}</div>
      <div class="hint mt-8">كلمات المرور معروضة هنا لأنها بيانات عرض فقط وليست أسرارًا.</div></div>
  </form></div>`;
}

function bindLogin(root) {
  const form = root.querySelector('#login-form');
  const btn = root.querySelector('#login-btn');
  root.querySelector('#pw-toggle').addEventListener('click', () => {
    const i = form.querySelector('[name=password]');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  root.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
    const [u, p] = b.dataset.fill.split('|');
    form.querySelector('[name=username]').value = u;
    form.querySelector('[name=password]').value = p;
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearInvalid(form);
    const d = formData(form);
    let bad = false;
    if (!d.username.trim()) { markInvalid(form, 'username', 'اسم المستخدم مطلوب'); bad = true; }
    if (!d.password) { markInvalid(form, 'password', 'كلمة المرور مطلوبة'); bad = true; }
    UI.loginUser = d.username.trim();
    if (bad) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> جارٍ الدخول...';
    setTimeout(() => {
      if (login(d.username, d.password)) {
        UI.loginError = '';
        const u = currentUser();
        const first = allowedNav()[0];
        location.hash = `#/${can('page.dashboard') ? 'dashboard' : first ? first.key : 'dashboard'}`;
        toast(`أهلًا ${u.name}`, 'ok');
        render();
      } else {
        UI.loginError = 'بيانات الدخول غير صحيحة';
        render();
      }
    }, 450);
  });
}

function shiftBadge() {
  const sh = currentShift();
  if (!sh) return '<span class="badge b-red">لا توجد وردية</span>';
  const h = (Date.now() - new Date(sh.openedAt).getTime()) / 3600000;
  return `<span class="badge ${h > 16 ? 'b-amber' : 'b-green'}">وردية مفتوحة — ${esc(sh.cashier)}${h > 16 ? ` ⚠ منذ ${fmtInt(Math.floor(h))} ساعة` : ''}</span>`;
}

function renderShell(key) {
  const page = PAGES[key];
  const user = currentUser();
  const role = currentRole();
  const nav = allowedNav();
  const low = lowStockItems(S).length;
  const items = nav.map((n) => `<button class="sb-item ${n.key === key ? 'active' : ''}" data-nav="${n.key}" title="${n.label}">${icon(n.icon)}<span>${SHORT[n.label] || n.label}</span></button>`).join('');
  const title = (NAV.find((n) => n.key === key) || {}).label;
  const allowed = can(`page.${key}`);
  const content = allowed ? page.render() : `<div class="empty"><div class="big">🔒</div><h3>غير مصرّح</h3><p>دور «${esc(role.label)}» لا يملك صلاحية هذه الشاشة (محاكاة واجهة — الباك إند يجب أن يفرض هذا لاحقًا).</p></div>`;
  return `<div class="app ${UI.menuOpen ? 'menu-open' : ''} ${S.settings.appearance.sidebarCompact ? 'compact' : ''}">
    <nav class="sidebar" aria-label="القائمة الرئيسية">
      <div class="sb-logo"><div class="mark">${icon('cashier', 22)}</div><div>كوفي</div></div>
      ${items}
      <div class="sb-spacer"></div><div class="sb-sep"></div>
      <button class="sb-item" data-act-logout title="تسجيل الخروج">${icon('logout')}<span>تسجيل الخروج</span></button>
    </nav>
    <div class="backdrop" data-backdrop></div>
    <div class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon menu-btn" data-menu aria-label="القائمة">${icon('menu')}</button>
        <div><h1>${title}</h1><div class="crumbs">كوفي ‹ ${title}</div></div>
        <span class="grow"></span>
        <span class="hide-sm">${shiftBadge()}</span>
        <button class="btn btn-ghost btn-icon" data-theme-toggle title="تبديل الوضع الفاتح/الداكن">${icon(S.settings.appearance.theme === 'dark' ? 'sun' : 'moon')}</button>
        <button class="btn btn-ghost btn-icon" data-bell title="التنبيهات" style="position:relative">${icon('bell')}${low ? `<span style="position:absolute;top:2px;inset-inline-start:2px;background:var(--red);color:#fff;border-radius:99px;font-size:10px;min-width:16px;height:16px;display:grid;place-items:center">${fmtInt(low)}</span>` : ''}</button>
        <div class="row" style="gap:8px"><div style="text-align:end;line-height:1.2"><div class="bold sm">${esc(user.name)}</div><div class="muted xs">${esc(role.label)}</div></div><div class="stat" style="padding:0;border:0;box-shadow:none"><div class="ico t-blue" style="width:36px;height:36px">${icon('user')}</div></div></div>
      </header>
      <main class="content ${key === 'cashier' && allowed ? 'flush' : ''}" id="content">${content}</main>
    </div>
  </div>`;
}

function bindShell(root, key) {
  root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  const lo = root.querySelector('[data-act-logout]');
  if (lo) lo.addEventListener('click', () => confirmDialog({ title: 'تسجيل الخروج', message: 'هل تريد تسجيل الخروج؟ سيبقى الطلب الحالي محفوظًا في هذا المتصفح.', confirmText: 'خروج', onConfirm: () => { logout(); location.hash = '#/dashboard'; } }));
  const mb = root.querySelector('[data-menu]');
  if (mb) mb.addEventListener('click', () => { UI.menuOpen = !UI.menuOpen; render(); });
  const bd = root.querySelector('[data-backdrop]');
  if (bd) bd.addEventListener('click', () => { UI.menuOpen = false; render(); });
  root.querySelector('[data-theme-toggle]').addEventListener('click', () => {
    commit((s) => { s.settings.appearance.theme = s.settings.appearance.theme === 'dark' ? 'light' : 'dark'; });
    applyTheme();
  });
  root.querySelector('[data-bell]').addEventListener('click', showAlerts);
  if (can(`page.${key}`) && PAGES[key].bind) PAGES[key].bind(root);
}

function showAlerts() {
  const low = lowStockItems(S);
  const held = S.orders.filter((o) => o.status === 'held').length;
  const wait = S.orders.filter((o) => o.awaitingPayment && o.status === 'pending').length;
  openModal({
    title: 'التنبيهات', size: 'sm',
    body: `<div class="col">
      ${low.length ? `<div><b>مخزون منخفض (${fmtInt(low.length)})</b>${low.slice(0, 8).map((i) => `<div class="kv"><span>${esc(i.name)}</span><span class="neg-num">${fmtQty(i.qty)} ${BASE_UNIT_LABEL[i.baseUnit]}</span></div>`).join('')}</div>` : '<div class="muted">لا توجد تنبيهات مخزون</div>'}
      <div class="kv"><span>طلبات معلّقة</span><b>${fmtInt(held)}</b></div>
      <div class="kv"><span>طاولات بانتظار الدفع</span><b>${fmtInt(wait)}</b></div>
    </div>`,
    footer: `<button class="btn" data-close>إغلاق</button>${can('page.inventory') ? '<button class="btn btn-primary" data-go-inv>فتح المخزون</button>' : ''}`,
    onMount(el, close) { const g = el.querySelector('[data-go-inv]'); if (g) g.addEventListener('click', () => { close(); go('inventory'); }); },
  });
}

// ----- حلقة الرسم الرئيسية -----
let lastKey = null;
function renderRecovery() {
  const kb = Math.round((RECOVERY.raw || '').length / 1024);
  const msg = RECOVERY.raw ? `تعذّرت قراءة البيانات المحفوظة (${fmtInt(kb)} ك.ب) ولم يُمسح أو يُستبدل أي شيء.` : 'لا توجد بيانات في التخزين الرئيسي للمتصفح (ربما تم مسحها)، لكن توجد نسخة داخلية محفوظة.';
  return `<div class="login"><div class="login-card"><div class="brand"><h1>⚠ مشكلة في البيانات المحفوظة</h1></div>
    <div class="demo-note">${msg}</div>
    <div class="col">${RECOVERY.idb ? '<button class="btn btn-success btn-lg" data-idb>استرجاع من النسخة الداخلية (IndexedDB)</button>' : ''}${RECOVERY.raw ? '<button class="btn btn-primary btn-lg" data-dl>تنزيل البيانات التالفة (JSON)</button>' : ''}<button class="btn btn-lg" data-retry>إعادة المحاولة</button><button class="btn btn-danger btn-lg" data-fresh>البدء ببيانات عرض جديدة (يستبدل المحفوظ)</button></div>
    <div class="hint mt-8">لو عندك نسخة احتياطية سليمة: ابدأ ببيانات جديدة ثم استعدها من «النسخ الاحتياطي».</div></div></div>`;
}
function bindRecovery(root) {
  const on = (sel, fn) => { const b = root.querySelector(sel); if (b) b.addEventListener('click', fn); };
  on('[data-dl]', () => downloadFile(`hyper-one-corrupt-${dayKey(new Date())}.json`, RECOVERY.raw, 'application/json'));
  on('[data-retry]', () => location.reload());
  on('[data-idb]', () => {
    let next = null;
    try { next = JSON.parse(RECOVERY.idb); } catch (e) { return toast('تعذر قراءة النسخة الداخلية', 'err'); }
    S = next; RECOVERY = null; migrateState(S); applyTheme(); idbReady = true; persistNow(); render();
    toast('تم الاسترجاع من النسخة الداخلية', 'ok');
  });
  on('[data-fresh]', () => confirmDialog({
    title: 'استبدال البيانات', message: 'سيتم استبدال البيانات المحفوظة ببيانات عرض جديدة. تأكد أنك نزّلت نسخة منها. متابعة؟', confirmText: 'استبدال', danger: true,
    onConfirm: () => { RECOVERY = null; S = buildSeed(); applyTheme(); idbReady = true; persistNow(); render(); },
  }));
}

function isMenuRoute() { return location.hash.startsWith('#/menu'); }
function renderPublicMenu() {
  const cats = S.categories.filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const sel = UI.menuCat || 'all';
  const t = S.settings.tax;
  const list = S.products.filter((p) => p.active && cats.some((c) => c.id === p.categoryId) && (sel === 'all' || p.categoryId === sel));
  const card = (p) => { const out = servingsAvailable(p) === 0; return `<div class="prod ${out ? 'out' : ''}" style="cursor:default"><div class="prod-img tone-${p.tone}" ${thumbStyle(p)}>${p.image ? '' : p.emoji}</div><div class="prod-name">${esc(p.name)}</div><div class="prod-price num">${out ? 'غير متاح حاليًا' : fmtMoney(p.price)}</div></div>`; };
  return `<div style="padding:14px;max-width:1000px;margin:0 auto">
    <div class="card"><div class="card-b" style="text-align:center"><h1>${esc(S.settings.business.name)}</h1><div class="muted">المنيو</div></div></div>
    <div class="cats mt-14"><button class="cat ${sel === 'all' ? 'on' : ''}" data-mcat="all"><span class="ci">🍽️</span>الكل</button>${cats.map((c) => `<button class="cat ${sel === c.id ? 'on' : ''}" data-mcat="${c.id}"><span class="ci">${c.icon}</span>${esc(c.name)}</button>`).join('')}</div>
    <div class="prod-grid mt-14" style="overflow:visible">${list.map(card).join('') || emptyState('لا توجد أصناف', '🍽️')}</div>
    <p class="center muted sm mt-14">${t.enabled && t.mode === 'exclusive' ? `الأسعار لا تشمل الضريبة (${fmtPct(t.ratePct)})` : ''}</p>
    <p class="center xs"><a href="#/dashboard">دخول الموظفين</a></p></div>`;
}
function bindPublicMenu(root) {
  root.querySelectorAll('[data-mcat]').forEach((b) => b.addEventListener('click', () => { UI.menuCat = b.dataset.mcat; render(); }));
}

function render() {
  const app = document.getElementById('app');
  if (!S) return;
  if (RECOVERY) { app.innerHTML = renderRecovery(); bindRecovery(app); return; }
  if (isMenuRoute()) { app.innerHTML = renderPublicMenu(); bindPublicMenu(app); lastKey = null; return; }
  const active = document.activeElement;
  const scrollEl = document.getElementById('content');
  const keepScroll = scrollEl && lastKey === route() ? scrollEl.scrollTop : 0;
  if (!currentUser()) {
    app.innerHTML = renderLogin();
    bindLogin(app);
    lastKey = null;
    return;
  }
  const key = route();
  const inner = ['.prod-grid', '.inv-items', '.cats'].map((sel) => { const e = document.querySelector(sel); return [sel, e ? (sel === '.cats' ? e.scrollLeft : e.scrollTop) : 0]; });
  app.innerHTML = renderShell(key);
  bindShell(app, key);
  const c = document.getElementById('content');
  if (c && keepScroll) c.scrollTop = keepScroll;
  inner.forEach(([sel, v]) => { const e = document.querySelector(sel); if (e && v) { if (sel === '.cats') e.scrollLeft = v; else e.scrollTop = v; } });
  lastKey = key;
  void active;
}

// ===== 50-cashier.js =====
// ---------------------------------------------------------------------------
// شاشة الكاشير (الأهم): الفاتورة يسارًا، المنتجات في المنتصف، القائمة يمينًا
// ---------------------------------------------------------------------------
function servingsAvailable(p) {
  if (p.stockMode === 'direct') return isWeight(p) ? null : Math.max(0, p.stockQty || 0);
  const lines = S.recipes[p.id];
  if (p.stockMode !== 'recipe' || !lines || !lines.length) return null;
  let min = Infinity;
  for (const l of lines) {
    const inv = invById(l.inventoryId);
    if (!inv) continue;
    const need = toBase(l.qty, l.unit, inv);
    if (need > 0) min = Math.min(min, Math.floor(inv.qty / need));
  }
  return min === Infinity ? null : Math.max(0, min);
}

function visibleProducts() {
  const q = UI.cashier.q.trim().toLowerCase();
  const activeCats = new Set(S.categories.filter((c) => c.active).map((c) => c.id));
  return S.products.filter((p) => p.active && activeCats.has(p.categoryId)
    && (UI.cashier.cat === 'all' || p.categoryId === UI.cashier.cat)
    && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)));
}

function productCardHtml(p) {
  const sv = servingsAvailable(p);
  const out = sv === 0 && S.settings.inventory.insufficientStock === 'block';
  const stock = sv == null ? '' : `<span class="stock ${sv <= 10 ? 'low' : ''}">مخزون ${fmtInt(sv)}</span>`;
  const opt = p.modifierGroupIds.length ? '<span class="opt-dot" title="قابل للتخصيص">⚙</span>' : '';
  return `<button class="prod ${out ? 'out' : ''}" data-pid="${p.id}" ${out ? 'disabled' : ''} aria-label="${esc(p.name)}">
    <div class="prod-img tone-${p.tone}" ${thumbStyle(p)}>${p.image ? '' : p.emoji}</div>${stock}${opt}
    <div class="prod-name">${esc(p.name)}</div><div class="prod-price num">${fmtMoney(p.price)}${isWeight(p) ? ' / كجم' : ''}</div></button>`;
}

function gridHtml() {
  const list = visibleProducts();
  if (!list.length) return `<div style="grid-column:1/-1">${emptyState('لا توجد أصناف مطابقة', '🔎')}</div>`;
  return list.map(productCardHtml).join('');
}

function catsHtml() {
  const cats = S.categories.filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  return `<button class="cat ${UI.cashier.cat === 'all' ? 'on' : ''}" data-cat="all"><span class="ci">🍽️</span>الكل</button>`
    + cats.map((c) => `<button class="cat ${UI.cashier.cat === c.id ? 'on' : ''}" data-cat="${c.id}"><span class="ci">${c.icon}</span>${esc(c.name)}</button>`).join('');
}

function cartItemsHtml() {
  const c = S.cart;
  if (!c.items.length) return `<div class="inv-empty"><div><div class="big">🛒</div><h3>الفاتورة فارغة</h3><div class="sm">اختر منتجًا لبدء البيع</div></div></div>`;
  const tot = cartTotals().t;
  return c.items.map((i, idx) => {
    const unit = cartUnitPrice(i);
    return `<div class="inv-item" data-key="${i.key}">
      <div class="thumb tone-${i.tone}" ${i.image ? `style="background-image:url('${esc(i.image)}')"` : ''}>${i.image ? '' : i.emoji}</div>
      <div><div class="nm">${esc(i.name)}${i.weightG ? ` — ⚖ ${fmtQty(i.weightG / 1000)} كجم` : ''}</div>
        ${i.options.length ? `<div class="op">${i.options.map((o) => esc(o.name) + (o.price ? ` (${o.price > 0 ? '+' : ''}${fmtNum(o.price)})` : '')).join(' • ')}</div>` : ''}
        ${i.note ? `<div class="nt">📝 ${esc(i.note)}</div>` : ''}
        <div class="qty">${i.weightG ? '' : `<button data-q="-1" aria-label="إنقاص">−</button><b class="num">${fmtInt(i.qty)}</b><button data-q="1" aria-label="زيادة">+</button>`}
          <button data-note title="ملاحظة على الصنف" style="margin-inline-start:4px">✎</button><button data-rm title="حذف" aria-label="حذف" style="color:var(--red)">${icon('trash')}</button></div></div>
      <div class="pr"><div class="num">${fmtNum(tot.lines[idx].lineTotal)}</div><div class="muted xs num">${i.weightG ? `${fmtNum(i.pricePerKg)} / كجم` : `${fmtNum(unit)} × ${fmtInt(i.qty)}`}</div></div></div>`;
  }).join('');
}

function draftPay() {
  const d = UI.cashier.draft;
  const tot = cartTotals().t;
  if (!d || d.total !== tot.total) return null;
  try { return allocatePayments(tot.total, d.payments, { allowPartial: true }); } catch (e) { return null; }
}

function totalsHtml() {
  const c = S.cart;
  const r = cartTotals();
  const t = r.t;
  const dp = draftPay();
  const tax = S.settings.tax;
  return `
    <div class="kv"><span>المجموع الفرعي</span><span class="num">${fmtMoney(t.subtotal)}</span></div>
    <div class="kv"><span>الخصم ${t.discountType === 'percent' ? `(${fmtPct(t.discountValue / 100)})` : ''}</span><span class="num ${t.discountAmount ? 'neg-num' : ''}">${t.discountAmount ? '−' : ''}${fmtMoney(t.discountAmount)}</span></div>
    <div class="kv"><span>${tax.enabled ? `الضريبة (${fmtPct(tax.ratePct)}${tax.mode === 'inclusive' ? ' شاملة' : ''})` : 'الضريبة (معطلة)'}</span><span class="num">${fmtMoney(t.taxAmount)}</span></div>
    ${t.deliveryFee ? `<div class="kv"><span>رسوم التوصيل</span><span class="num">${fmtMoney(t.deliveryFee)}</span></div>` : ''}
    ${r.ok ? '' : `<div class="err-t">${esc(r.error)}</div>`}
    <div class="grand"><span>الإجمالي المستحق</span><b class="num">${fmtMoney(t.total)}</b></div>
    ${dp && dp.paid ? `<div class="kv"><span>المدفوع</span><span class="num">${fmtMoney(dp.paid)}</span></div>
    <div class="kv"><span>المتبقي</span><span class="num ${dp.remaining === 0 ? 'pos-num' : ''}">${fmtMoney(dp.remaining)}</span></div>` : ''}
    ${dp && dp.change ? `<div class="kv"><span>الباقي للعميل</span><b class="num pos-num">${fmtMoney(dp.change)}</b></div>` : ''}`;
}

function deliveryFieldsHtml() {
  const d = S.cart.delivery || { name: '', phone: '', address: '', fee: 0 };
  return `<div class="col gap-4" style="padding:5px;border:1px dashed var(--primary);border-radius:10px">
    <div class="row gap-4"><input class="input" data-dlv="phone" inputmode="tel" placeholder="رقم الموبايل *" value="${esc(d.phone)}" style="direction:ltr;text-align:right;height:34px"><input class="input" data-dlv="name" placeholder="اسم العميل" value="${esc(d.name)}" style="height:34px"></div>
    <div class="row gap-4"><input class="input" data-dlv="address" placeholder="العنوان *" value="${esc(d.address)}" style="height:34px"><input class="input" data-dlv="fee" inputmode="decimal" placeholder="رسوم التوصيل" value="${d.fee ? egpToInput(d.fee) : ''}" style="width:104px;height:34px"></div></div>`;
}

function invoiceHtml() {
  const c = S.cart;
  const ord = c.orderId ? S.orders.find((o) => o.id === c.orderId) : null;
  const no = ord ? ord.no : `${S.settings.invoice.prefix}${pad(S.counters.order + 1, 6)}`;
  const empty = !c.items.length;
  const tables = S.tables.map((tb) => {
    const st = tableState(S, tb.number);
    const mine = st.order && st.order.id === c.orderId;
    const busy = st.order && !mine;
    return `<option value="${tb.number}" ${c.tableId === tb.number ? 'selected' : ''} ${busy ? 'disabled' : ''}>طاولة ${fmtInt(tb.number)}${busy ? ' (مشغولة)' : ''}</option>`;
  }).join('');
  const dp = draftPay();
  const canComplete = !empty && dp && dp.remaining === 0;
  return `<aside class="inv" aria-label="الفاتورة الحالية">
    <div class="inv-head">
      <div class="row between"><div><div class="bold">فاتورة ${esc(no)}</div><div class="muted xs">${ord ? 'طلب محفوظ — تعديل' : 'فاتورة جديدة'} • ${esc(currentUser().name)}</div></div>
        <button class="btn btn-ghost btn-icon btn-sm" data-inv-close title="إغلاق" style="display:none">${icon('x')}</button>
        <button class="btn btn-sm" data-order-note>${icon('edit')} ملاحظة</button></div>
      <div class="seg full" data-type>${Object.entries(ORDER_TYPES).filter(([k]) => !(isMarket() && k === 'dine_in')).map(([k, l]) => `<button type="button" data-t="${k}" class="${c.type === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="row">
        ${c.type === 'dine_in' ? `<select class="select" data-table aria-label="الطاولة"><option value="">اختر الطاولة</option>${tables}</select>` : ''}
        <select class="select" data-customer aria-label="العميل"><option value="">عميل عام</option>${options(S.customers.filter((x) => x.active), c.customerId)}</select>
      </div>
      ${c.type === 'delivery' ? deliveryFieldsHtml() : ''}
      ${c.note ? `<div class="nt sm" style="color:var(--amber)">📝 ${esc(c.note)}</div>` : ''}
    </div>
    <div class="inv-items" id="inv-items">${cartItemsHtml()}</div>
    <div class="inv-totals" id="inv-totals">${totalsHtml()}</div>
    <div class="row" style="padding:8px 12px 0"><button class="btn btn-sm grow" data-discount ${empty || !can('discount.apply') ? 'disabled' : ''} title="${can('discount.apply') ? '' : 'لا تملك صلاحية الخصم'}">🏷️ ${S.cart.discount.type ? 'تعديل الخصم' : 'إضافة خصم'}</button>
      ${S.cart.discount.type ? '<button class="btn btn-sm btn-ghost" data-discount-clear>إزالة الخصم</button>' : ''}</div>
    <div class="inv-actions">
      <button class="btn btn-success btn-lg" data-pay ${empty ? 'disabled' : ''}>${icon('card')} الدفع</button>
      <button class="btn btn-primary btn-lg" data-complete ${canComplete ? '' : 'disabled'} title="${canComplete ? '' : 'اضغط «الدفع» أولًا وأدخل المبالغ'}">${icon('check')} إتمام البيع</button>
      <div class="inv-mini">
        <button class="btn btn-sm" data-save ${empty ? 'disabled' : ''}>${icon('check')} حفظ</button>
        <button class="btn btn-sm" data-hold ${empty ? 'disabled' : ''}>${icon('pause')} تعليق</button>
        <button class="btn btn-sm" data-kitchen ${empty ? 'disabled' : ''}>${icon('kitchen')} المطبخ</button>
        <button class="btn btn-sm btn-danger" data-clear ${empty ? 'disabled' : ''} title="تفريغ الفاتورة">${icon('trash')} تفريغ</button>
        <button class="btn btn-sm" style="grid-column:1/-1" data-printbill ${empty ? 'disabled' : ''}>${icon('print')} طباعة الفاتورة (قبل الدفع)</button>
      </div>
    </div>
  </aside>`;
}

PAGES.cashier = {
  render() {
    if (isMarket() && S.cart.type === 'dine_in') S.cart.type = 'takeaway';
    const sh = currentShift();
    return `<div class="pos ${UI.cashier.invOpen ? 'inv-open' : ''}" id="pos">
      <section class="pos-main">
        ${sh ? '' : `<div class="demo-note" style="margin:0">⚠️ لا توجد وردية مفتوحة — لا يمكن إتمام البيع. <a href="#/cashbox">افتح وردية</a></div>`}
        <div class="pos-top">
          <div class="input-ico search">${icon('search')}<input class="input" id="q" placeholder="ابحث عن منتج أو اسم أو SKU..." value="${esc(UI.cashier.q)}" autocomplete="off"></div>
        </div>
        <div class="cats" id="cats">${catsHtml()}</div>
        <div class="prod-grid" id="prod-grid">${gridHtml()}</div>
      </section>
      ${invoiceHtml()}
      <button class="btn btn-primary fab-cart" data-fab>${icon('cart')} الفاتورة (${fmtInt(sum(S.cart.items, (i) => i.qty))}) — ${fmtMoney(cartTotals().t.total)}</button>
    </div>`;
  },
  bind(root) { bindCashier(root); },
};

function printDraftBill() {
  const c = S.cart;
  if (!c.items.length) return toast('الفاتورة فارغة', 'err');
  const fake = { ...S, counters: { ...S.counters } }; // لا نستهلك رقم فاتورة حقيقي
  const base = c.orderId ? S.orders.find((x) => x.id === c.orderId) : null;
  const o = makeOrder(fake, c, { status: 'pending', cashier: currentUser().name });
  if (base) o.no = base.no;
  const html = receiptHtml(o, { draft: true });
  openModal({
    title: 'طباعة الفاتورة (قبل الدفع)', size: 'sm', body: `<div class="paper-bg">${html}</div>`,
    footer: `<button class="btn" data-close>إغلاق</button><button class="btn btn-primary" data-print>${icon('print')} طباعة</button>`,
    onMount(el) { el.querySelector('[data-print]').addEventListener('click', () => printHtml(html)); },
  });
}

function openWeightDialog(p) {
  const num = (v) => Number(String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
  openModal({
    title: `الوزن — ${esc(p.name)}`, size: 'sm',
    body: `<div class="col"><div class="muted">السعر: <b class="num">${fmtMoney(p.price)}</b> / كجم</div>${field('الوزن', '<div class="row"><input class="input" name="w" inputmode="decimal" placeholder="0.000"><select class="select" name="u" style="width:100px"><option value="kg">كجم</option><option value="g">جرام</option></select></div>')}<div class="kv total"><span>سعر الوزن</span><b class="num" data-pr>${fmtMoney(0)}</b></div><div class="hint">يُدخل الوزن يدويًا (لا يوجد ربط بميزان من المتصفح).</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>إضافة للفاتورة</button>',
    onMount(el, close) {
      const grams = () => { const v = num(el.querySelector('[name=w]').value); return Math.round(el.querySelector('[name=u]').value === 'kg' ? v * 1000 : v); };
      const upd = () => { const g = grams(); el.querySelector('[data-pr]').textContent = fmtMoney(g > 0 ? Math.round((p.price * g) / 1000) : 0); };
      el.querySelector('[name=w]').addEventListener('input', upd);
      el.querySelector('[name=u]').addEventListener('change', upd);
      const add = () => {
        clearInvalid(el);
        const g = grams();
        if (!(g >= 1 && g <= 100000)) return markInvalid(el, 'w', 'أدخل وزنًا صحيحًا (حتى 100 كجم)');
        if (Math.round((p.price * g) / 1000) <= 0) return markInvalid(el, 'w', 'الوزن صغير جدًا');
        close();
        commit((st) => { st.cart.items.push(weightItemFrom(p, g)); });
      };
      el.querySelector('[data-ok]').addEventListener('click', add);
      el.querySelector('[name=w]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    },
  });
}

function clickProduct(p) {
  if (isWeight(p)) return openWeightDialog(p);
  if (p.modifierGroupIds.length) openOptionsDialog(p);
  else addToCart(p, [], 1);
}

function bindCashier(root) {
  const pos = root.querySelector('#pos');
  const grid = root.querySelector('#prod-grid');
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pid]');
    if (!b) return;
    const p = S.products.find((x) => x.id === b.dataset.pid);
    if (p) clickProduct(p);
  });
  root.querySelector('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    UI.cashier.cat = b.dataset.cat;
    root.querySelector('#cats').innerHTML = catsHtml();
    grid.innerHTML = gridHtml();
  });
  const q = root.querySelector('#q');
  q.addEventListener('input', () => { UI.cashier.q = q.value; grid.innerHTML = gridHtml(); });
  // الفاتورة
  const items = root.querySelector('#inv-items');
  items.addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    const key = row.dataset.key;
    const qb = e.target.closest('[data-q]');
    if (qb) return setQty(key, Number(qb.dataset.q));
    if (e.target.closest('[data-rm]')) return removeFromCart(key);
    if (e.target.closest('[data-note]')) return editItemNote(key);
  });
  root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => commit((s) => { s.cart.type = b.dataset.t; if (b.dataset.t !== 'dine_in') s.cart.tableId = null; })));
  root.querySelectorAll('[data-dlv]').forEach((i) => i.addEventListener('change', () => {
    const k = i.dataset.dlv;
    const v = i.value.trim();
    if (k === 'fee') {
      const f = v === '' ? 0 : parseEgp(v);
      if (Number.isNaN(f) || f < 0) return toast('رسوم التوصيل غير صحيحة', 'err');
      commit((st) => { deliveryOf(st.cart).fee = f; }, { silent: true });
      const tt = root.querySelector('#inv-totals');
      if (tt) tt.innerHTML = totalsHtml();
    } else commit((st) => { deliveryOf(st.cart)[k] = v; }, { silent: true });
  }));
  const tb = root.querySelector('[data-table]');
  if (tb) tb.addEventListener('change', () => commit((s) => { s.cart.tableId = tb.value ? Number(tb.value) : null; }));
  root.querySelector('[data-customer]').addEventListener('change', (e) => commit((s) => { s.cart.customerId = e.target.value || null; }));
  root.querySelector('[data-order-note]').addEventListener('click', editOrderNote);
  const dsc = root.querySelector('[data-discount]');
  if (dsc) dsc.addEventListener('click', openDiscountDialog);
  const dcl = root.querySelector('[data-discount-clear]');
  if (dcl) dcl.addEventListener('click', () => commit((s) => { s.cart.discount = { type: null, value: 0, reason: '', approvedBy: '' }; }));
  root.querySelector('[data-pay]').addEventListener('click', openPaymentDialog);
  root.querySelector('[data-printbill]').addEventListener('click', printDraftBill);
  root.querySelector('[data-clear]').addEventListener('click', () => confirmDialog({ title: 'تفريغ الفاتورة', message: 'سيتم حذف كل الأصناف من الفاتورة الحالية. هل أنت متأكد؟', confirmText: 'تفريغ', danger: true, onConfirm: () => { clearCart(); UI.cashier.draft = null; toast('تم تفريغ الفاتورة', 'info'); } }));
  root.querySelector('[data-save]').addEventListener('click', () => {
    const r = saveCartAsOrder('pending');
    if (!r.ok) return toast(r.error, 'err');
    UI.cashier.draft = null;
    toast(`تم حفظ الطلب ${r.order.no}`, 'ok');
  });
  root.querySelector('[data-hold]').addEventListener('click', () => {
    const r = saveCartAsOrder('held');
    if (!r.ok) return toast(r.error, 'err');
    UI.cashier.draft = null;
    toast(`تم تعليق الطلب ${r.order.no} — يمكن إعادة فتحه من «الطلبات»`, 'ok');
  });
  root.querySelector('[data-kitchen]').addEventListener('click', () => {
    const r = sendToKitchen();
    if (!r.ok) return toast(r.error, 'err');
    UI.cashier.draft = null;
    const pr = S.printers.find((p) => p.role === 'kitchen');
    if (!r.fresh.length) toast('لا توجد أصناف جديدة لإرسالها للمطبخ', 'warn');
    else if (pr.simulatedStatus !== 'connected') toast('طابعة المطبخ غير متصلة (محاكاة) — الطلب محفوظ، أعد المحاولة من إعدادات الطابعات', 'err');
    else toast('أُرسلت تذكرة المطبخ (محاكاة — لا توجد طباعة فعلية)', 'ok');
    if (r.fresh.length) openModal({ title: 'تذكرة المطبخ / البار (معاينة)', size: 'sm', body: `<div class="paper-bg">${kitchenTicketHtml(r.order, r.fresh)}</div>`, footer: '<button class="btn" data-close>إغلاق</button>' });
  });
  root.querySelector('[data-complete]').addEventListener('click', () => {
    const d = UI.cashier.draft;
    if (!d) return;
    finishSale(d.payments);
  });
  const fab = root.querySelector('[data-fab]');
  if (fab) fab.addEventListener('click', () => { UI.cashier.invOpen = true; pos.classList.add('inv-open'); const cl = root.querySelector('[data-inv-close]'); if (cl) cl.style.display = ''; });
  const cl = root.querySelector('[data-inv-close]');
  if (cl) {
    if (window.matchMedia('(max-width: 820px)').matches) cl.style.display = '';
    cl.addEventListener('click', () => { UI.cashier.invOpen = false; pos.classList.remove('inv-open'); });
  }
}

const QUICK_ITEM_NOTES = ['بدون سكر', 'سكر زيادة', 'بدون ثلج', 'ثلج زيادة', 'سخن', 'فاتر', 'بدون كريمة', 'بدون نعناع'];
function editItemNote(key) {
  const it = S.cart.items.find((x) => x.key === key);
  if (!it) return;
  openModal({
    title: `ملاحظة — ${esc(it.name)}`, size: 'sm',
    body: field('ملاحظات التحضير', `<textarea class="textarea" name="note" placeholder="اكتب أو اختر من الأسفل">${esc(it.note)}</textarea>`)
      + `<div class="chips mt-8">${QUICK_ITEM_NOTES.map((n) => `<button type="button" class="chip" data-qn="${esc(n)}">${esc(n)}</button>`).join('')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const ta = el.querySelector('[name=note]');
      el.querySelectorAll('[data-qn]').forEach((b) => b.addEventListener('click', () => {
        const parts = ta.value.split(' • ').filter(Boolean);
        const i = parts.indexOf(b.dataset.qn);
        if (i >= 0) parts.splice(i, 1); else parts.push(b.dataset.qn);
        ta.value = parts.join(' • ');
        b.classList.toggle('on', i < 0);
      }));
      el.querySelector('[data-ok]').addEventListener('click', () => { const v = ta.value.trim(); close(); commit((s) => { const x = s.cart.items.find((y) => y.key === key); if (x) x.note = v; }); });
    },
  });
}

const QUICK_NOTES = ['مستعجل', 'بدون سكر', 'بدون ثلج', 'سخن جدًا', 'تغليف منفصل', 'بدون مخلل', 'تقديم مع بعض'];
function editOrderNote() {
  openModal({
    title: 'ملاحظة العميل على الطلب', size: 'sm',
    body: field('ملاحظة الطلب', `<textarea class="textarea" name="note" placeholder="اكتب طلب العميل أو اختر من الأسفل">${esc(S.cart.note)}</textarea>`)
      + `<div class="chips mt-8">${QUICK_NOTES.map((n) => `<button type="button" class="chip" data-qn="${esc(n)}">${esc(n)}</button>`).join('')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const ta = el.querySelector('[name=note]');
      el.querySelectorAll('[data-qn]').forEach((b) => b.addEventListener('click', () => {
        const parts = ta.value.split(' • ').filter(Boolean);
        const i = parts.indexOf(b.dataset.qn);
        if (i >= 0) parts.splice(i, 1); else parts.push(b.dataset.qn);
        ta.value = parts.join(' • ');
        b.classList.toggle('on', i < 0);
      }));
      el.querySelector('[data-ok]').addEventListener('click', () => { const v = ta.value.trim(); close(); commit((s) => { s.cart.note = v; }); });
    },
  });
}

// ----- نافذة تخصيص المنتج -----
function openOptionsDialog(p) {
  const groups = p.modifierGroupIds.map((id) => S.modifierGroups.find((g) => g.id === id)).filter(Boolean);
  const sel = {};
  defaultOptionsFor(p, S.modifierGroups).forEach((o) => { (sel[o.groupId] = sel[o.groupId] || []).push(o.optionId); });
  let qty = 1;
  const body = () => `
    <div class="opt-head"><div class="pic tone-${p.tone}" ${thumbStyle(p)}>${p.image ? '' : p.emoji}</div>
      <div><h3 style="font-size:18px">${esc(p.name)}</h3><div class="muted">${esc(categoryName(p.categoryId))}</div><div class="bold num" style="color:var(--primary);font-size:18px" data-live>${fmtMoney(price())}</div></div></div>
    ${groups.map((g) => `<div class="opt-group"><h4>${esc(g.name)} ${g.required ? badge('مطلوب', 'blue') : badge(g.multi ? 'اختياري — متعدد' : 'اختياري', 'gray')}</h4>
      <div class="opt-row">${g.options.map((o) => `<button type="button" class="opt ${(sel[g.id] || []).includes(o.id) ? 'on' : ''}" data-g="${g.id}" data-o="${o.id}">${esc(o.name)}${o.price ? `<small>${o.price > 0 ? '+' : '−'}${fmtNum(Math.abs(o.price))} ج.م</small>` : ''}</button>`).join('')}</div></div>`).join('')}
    ${field('ملاحظات التحضير', '<textarea class="textarea" name="note" placeholder="مثال: بدون سكر – درجة حرارة متوسطة"></textarea>')}`;
  const chosen = () => groups.flatMap((g) => (sel[g.id] || []).map((oid) => { const o = g.options.find((x) => x.id === oid); return { groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, price: o.price }; }));
  const price = () => Math.max(0, p.price + sum(chosen(), (o) => o.price)) * qty;
  openModal({
    title: 'تخصيص المنتج', size: 'lg', body: body(),
    footer: `<div class="row" style="margin-inline-end:auto"><button class="btn btn-icon" data-qm>−</button><b class="num" data-qty style="min-width:28px;text-align:center">${fmtInt(qty)}</b><button class="btn btn-icon" data-qp>+</button></div><button class="btn" data-close>إلغاء</button><button class="btn btn-primary btn-lg" data-add>إضافة للطلب</button>`,
    onMount(el, close) {
      const refresh = () => {
        el.querySelector('[data-live]').textContent = fmtMoney(price());
        el.querySelector('[data-qty]').textContent = fmtInt(qty);
        el.querySelectorAll('.opt').forEach((b) => b.classList.toggle('on', (sel[b.dataset.g] || []).includes(b.dataset.o)));
      };
      el.querySelector('.modal-b').addEventListener('click', (e) => {
        const b = e.target.closest('.opt');
        if (!b) return;
        const g = groups.find((x) => x.id === b.dataset.g);
        const cur = sel[g.id] || [];
        if (g.multi) sel[g.id] = cur.includes(b.dataset.o) ? cur.filter((x) => x !== b.dataset.o) : [...cur, b.dataset.o];
        else if (cur[0] === b.dataset.o && !g.required) sel[g.id] = [];
        else sel[g.id] = [b.dataset.o];
        refresh();
      });
      el.querySelector('[data-qm]').addEventListener('click', () => { qty = Math.max(1, qty - 1); refresh(); });
      el.querySelector('[data-qp]').addEventListener('click', () => { qty += 1; refresh(); });
      el.querySelector('[data-add]').addEventListener('click', () => {
        const miss = groups.find((g) => g.required && !(sel[g.id] || []).length);
        if (miss) return toast(`اختر ${miss.name}`, 'err');
        const note = el.querySelector('[name=note]').value.trim();
        const opts = chosen();
        close();
        commit((s) => {
          const sig = optionsSignature(opts);
          const ex = note ? null : s.cart.items.find((i) => i.productId === p.id && optionsSignature(i.options) === sig && !i.note);
          if (ex) ex.qty += qty; else s.cart.items.push(cartItemFrom(p, opts, qty, note));
        });
      });
    },
  });
}

// ----- الخصم -----
function openDiscountDialog() {
  const set = S.settings.discounts;
  const cur = S.cart.discount;
  const subtotal = cartTotals().t.subtotal;
  const types = [set.allowPercent ? ['percent', 'نسبة مئوية ٪'] : null, set.allowFixed ? ['fixed', 'مبلغ ثابت (ج.م)'] : null].filter(Boolean);
  if (!types.length) return toast('الخصومات معطلة من الإعدادات', 'err');
  openModal({
    title: 'إضافة خصم على الفاتورة', size: 'sm',
    body: `<div class="col">
      ${field('نوع الخصم', `<select class="select" name="type">${types.map(([k, l]) => `<option value="${k}" ${cur.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${field('القيمة', `<input class="input" name="value" inputmode="decimal" value="${cur.type === 'percent' ? egpToInput(cur.value) : cur.type ? egpToInput(cur.value) : ''}" placeholder="0">`)}
      ${field('السبب', `<input class="input" name="reason" value="${esc(cur.reason || '')}" placeholder="مثال: عميل دائم">`)}
      <div class="hint">الحد الأقصى: ${fmtPct(set.maxPercent)} أو ${fmtMoney(set.maxFixed)}. الخصم فوق ${fmtPct(set.requireApprovalAbovePercent)} يتطلب اعتماد مدير (محاكاة).</div>
      <div id="appr" class="hidden">${field('اعتماد المدير (محاكاة): كلمة مرور مدير العرض', '<input class="input" type="password" name="appr" placeholder="manager123">')}<div class="hint">هذه محاكاة واجهة فقط، وليست حماية حقيقية.</div></div>
    </div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>تطبيق</button>',
    onMount(el, close) {
      const typeEl = el.querySelector('[name=type]');
      const valEl = el.querySelector('[name=value]');
      const apprBox = el.querySelector('#appr');
      const needAppr = () => {
        const v = parseEgp(valEl.value);
        if (typeEl.value !== 'percent' || Number.isNaN(v)) return false;
        return v * 100 > set.requireApprovalAbovePercent * 100 && !can('discount.approve');
      };
      const upd = () => apprBox.classList.toggle('hidden', !needAppr());
      typeEl.addEventListener('change', upd); valEl.addEventListener('input', upd); upd();
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const type = typeEl.value;
        const raw = parseEgp(valEl.value);
        if (Number.isNaN(raw) || raw <= 0) return markInvalid(el, 'value', 'أدخل قيمة صحيحة أكبر من صفر');
        const value = raw; // نسبة: 12.5 ← 1250 نقطة أساس، مبلغ: بالقروش
        if (type === 'percent' && value > set.maxPercent * 100) return markInvalid(el, 'value', `الحد الأقصى ${fmtPct(set.maxPercent)}`);
        if (type === 'fixed' && value > set.maxFixed) return markInvalid(el, 'value', `الحد الأقصى ${fmtMoney(set.maxFixed)}`);
        if (type === 'fixed' && value > subtotal) return markInvalid(el, 'value', 'الخصم يتجاوز إجمالي الفاتورة');
        const reason = el.querySelector('[name=reason]').value.trim();
        let approvedBy = '';
        if (needAppr()) {
          const pw = el.querySelector('[name=appr]').value;
          const mgr = S.users.find((u) => u.active && ['r_admin', 'r_manager'].includes(u.roleId) && checkPassword(u, pw));
          if (!mgr) return markInvalid(el, 'appr', 'اعتماد المدير غير صحيح');
          approvedBy = mgr.name;
        } else if (can('discount.approve')) approvedBy = currentUser().name;
        close();
        commit((s) => { s.cart.discount = { type, value, reason, approvedBy }; });
        toast('تم تطبيق الخصم', 'ok');
      });
    },
  });
}

// ----- الدفع (طرق متعددة) -----
function openPaymentDialog() {
  const tot = cartTotals();
  if (!tot.ok) return toast(tot.error, 'err');
  if (!currentShift()) return toast('لا توجد وردية مفتوحة. افتح وردية من شاشة الخزنة والورديات.', 'err');
  if (S.cart.type === 'dine_in' && !S.cart.tableId) return toast('اختر الطاولة لطلب الصالة أو غيّر النوع إلى تيك أواي/ديليفري', 'err');
  { const de = deliveryError(S.cart); if (de) return toast(de, 'err'); }
  const total = tot.t.total;
  const methods = S.settings.payments.methods.filter((m) => m.enabled);
  const prev = UI.cashier.draft && UI.cashier.draft.total === total ? UI.cashier.draft.payments : [];
  const amounts = {};
  methods.forEach((m) => { const p = prev.find((x) => x.method === m.key); amounts[m.key] = p ? p.amount : 0; });
  openModal({
    title: 'شاشة الدفع (طرق متعددة)', size: 'sm',
    body: `<div class="pay-total"><span>إجمالي الفاتورة</span><b class="num">${fmtMoney(total)}</b></div>
      <div class="quick-amts"><button class="btn btn-sm" data-fill-cash>النقدي = كامل المبلغ</button>${[5000, 10000, 20000, 50000].map((v) => `<button class="btn btn-sm" data-add-cash="${v}">+${fmtInt(v / 100)}</button>`).join('')}<button class="btn btn-sm btn-ghost" data-zero>تصفير</button></div>
      ${methods.map((m) => `<div class="pay-row"><div class="pi t-blue">${METHOD_ICON[m.key] || '🧾'}</div><b>${esc(m.label)}</b><input class="input" data-m="${m.key}" inputmode="decimal" value="${amounts[m.key] ? egpToInput(amounts[m.key]) : ''}" placeholder="0"><button class="btn btn-ghost btn-sm btn-icon" data-rest="${m.key}" title="الباقي هنا">⤵</button></div>`).join('')}
      <div class="card" style="margin-top:12px"><div class="card-b" id="pay-sum"></div></div>
      <div class="err-t" id="pay-err"></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-success btn-lg" data-ok>تأكيد الدفع وطباعة الفاتورة</button>',
    onMount(el, close) {
      const inputs = [...el.querySelectorAll('[data-m]')];
      const read = () => inputs.map((i) => { const v = i.value.trim() === '' ? 0 : parseEgp(i.value); return { method: i.dataset.m, amount: v, el: i }; });
      let state = null;
      const calc = () => {
        const rows = read();
        let err = '';
        rows.forEach((r) => r.el.classList.toggle('invalid', Number.isNaN(r.amount)));
        if (rows.some((r) => Number.isNaN(r.amount))) err = 'أدخل مبالغ صحيحة (حتى خانتين عشريتين)';
        let a = null;
        if (!err) {
          try { a = allocatePayments(total, rows.map((r) => ({ method: r.method, amount: r.amount })), { allowPartial: true }); } catch (e) { err = e.message; }
        }
        state = { rows, a, err };
        const ok = a && a.remaining === 0 && !err;
        el.querySelector('#pay-sum').innerHTML = a ? `<div class="kv"><span>المدفوع</span><b class="num">${fmtMoney(a.paid)}</b></div><div class="kv"><span>المتبقي</span><b class="num ${a.remaining ? 'neg-num' : 'pos-num'}">${fmtMoney(a.remaining)}</b></div><div class="kv"><span>الباقي للعميل (نقدي فقط)</span><b class="num">${fmtMoney(a.change)}</b></div>` : '';
        el.querySelector('#pay-err').textContent = err || (a && a.remaining > 0 ? 'المبلغ المدفوع أقل من الإجمالي' : '');
        el.querySelector('[data-ok]').disabled = !ok;
        UI.cashier.draft = { total, payments: rows.filter((r) => !Number.isNaN(r.amount) && r.amount > 0).map((r) => ({ method: r.method, amount: r.amount })) };
      };
      inputs.forEach((i) => i.addEventListener('input', calc));
      const cash = inputs.find((i) => i.dataset.m === 'cash');
      el.querySelector('[data-fill-cash]').addEventListener('click', () => { if (!cash) return; inputs.forEach((i) => { if (i !== cash) i.value = ''; }); cash.value = egpToInput(total); calc(); });
      el.querySelectorAll('[data-add-cash]').forEach((b) => b.addEventListener('click', () => { if (!cash) return; const cur = cash.value.trim() === '' ? 0 : parseEgp(cash.value); cash.value = egpToInput((Number.isNaN(cur) ? 0 : cur) + Number(b.dataset.addCash)); calc(); }));
      el.querySelector('[data-zero]').addEventListener('click', () => { inputs.forEach((i) => { i.value = ''; }); calc(); });
      el.querySelectorAll('[data-rest]').forEach((b) => b.addEventListener('click', () => {
        const target = inputs.find((i) => i.dataset.m === b.dataset.rest);
        const others = sum(inputs.filter((i) => i !== target), (i) => { const v = i.value.trim() === '' ? 0 : parseEgp(i.value); return Number.isNaN(v) ? 0 : v; });
        const rest = Math.max(0, total - others);
        target.value = rest ? egpToInput(rest) : '';
        calc();
      }));
      el.querySelector('[data-ok]').addEventListener('click', (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled || !state || !state.a || state.a.remaining) return;
        btn.disabled = true; // منع الضغط المزدوج
        const pays = state.rows.filter((r) => r.amount > 0).map((r) => ({ method: r.method, amount: r.amount }));
        close();
        finishSale(pays);
      });
      calc();
    },
    onClose() { render(); },
  });
}

function sendTelegram(token, chatId, text) {
  if (!/^\d+:[\w-]+$/.test(String(token || '').trim()) || !/^-?\d+$/.test(String(chatId || '').trim())) return Promise.reject(new Error('إعدادات غير صحيحة'));
  return fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId.trim(), text }) })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); });
}
function notifyManager(o) {
  const n = S.settings.notify;
  if (!n || !n.enabled) return;
  const text = `فاتورة مدفوعة ${o.no}\nالإجمالي: ${fmtMoney(o.total)}\nالكاشير: ${o.cashier}\n${ORDER_TYPES[o.type]}${o.tableId ? ` — طاولة ${o.tableId}` : ''}`;
  sendTelegram(n.botToken, n.chatId, text).catch(() => toast('تعذر إرسال إشعار المدير (الإنترنت أو الإعدادات) — البيع تم وتحفظ الفاتورة', 'warn'));
}

function finishSale(payments) {
  const r = completeSale(payments);
  if (!r.ok) { toast(r.error, 'err'); render(); return; }
  UI.cashier.draft = null;
  const o = r.order;
  notifyManager(o);
  const rp = S.printers.find((p) => p.role === 'receipt');
  const printNote = S.settings.invoice.autoPrint && rp.autoPrint
    ? (rp.simulatedStatus === 'connected' ? 'تمت محاكاة إرسال الإيصال لطابعة الكاشير — لا توجد طباعة فعلية.' : 'طابعة الكاشير غير متصلة (محاكاة) — البيع محفوظ ويمكن إعادة الطباعة لاحقًا.')
    : 'الطباعة التلقائية متوقفة.';
  openModal({
    title: '✅ تم إتمام البيع (تجريبي)', size: 'sm',
    body: `<div class="demo-note">${printNote} هذه العملية محفوظة في هذا المتصفح فقط ولم تُرسل لأي خادم.</div><div class="paper-bg">${receiptHtml(o)}</div>`,
    footer: `<button class="btn" data-close>فاتورة جديدة</button><button class="btn btn-primary" data-print>${icon('print')} طباعة من المتصفح</button>`,
    onMount(el) { el.querySelector('[data-print]').addEventListener('click', () => printHtml(receiptHtml(o))); },
  });
}

// ===== 60-dashboard.js =====
// ---------------------------------------------------------------------------
// الرئيسية (لوحة المؤشرات) — كل الأرقام محسوبة من سجلات العرض التجريبية
// ---------------------------------------------------------------------------
const PERIODS = [['today', 'اليوم'], ['week', 'آخر 7 أيام'], ['month', 'آخر 30 يومًا']];

function periodSeg(current, attr) {
  return `<div class="seg">${PERIODS.map(([k, l]) => `<button type="button" ${attr}="${k}" class="${current === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

PAGES.dashboard = {
  render() {
    const range = periodRange(UI.dash.period);
    const k = kpis(S, range);
    const refunds = refundsIn(S, range);
    const low = lowStockItems(S);
    const days = groupByDay(k.orders, range);
    const top = topProducts(k.orders, 6);
    const pay = paymentBreakdown(k.orders);
    const sh = currentShift();
    const sm = sh ? shiftSummary(S, sh) : null;
    const recent = S.orders.filter((o) => o.status === 'completed').slice().sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 7);
    return `
      ${demoNote('بيانات تجريبية: كل الأرقام محسوبة من سجلات العرض المحفوظة في هذا المتصفح فقط، وليست أرقام نشاط حقيقي.')}
      <div class="page-head"><h2>ملخص النشاط</h2>
        <div class="row wrap">${periodSeg(UI.dash.period, 'data-period')}
          ${can('page.cashier') ? `<button class="btn btn-primary" data-go="cashier">${icon('cashier')} بيع جديد</button>` : ''}
          ${can('page.tables') ? `<button class="btn" data-go="tables">${icon('tables')} الطاولات</button>` : ''}
          ${can('page.cashbox') ? `<button class="btn" data-go="cashbox">${icon('cashbox')} الوردية</button>` : ''}
          ${can('page.inventory') ? `<button class="btn" data-go="inventory">${icon('inventory')} المخزون</button>` : ''}</div></div>
      <div class="stats">
        ${statCard('إجمالي المبيعات', fmtMoney(k.total), 'blue', 'money', 'شامل الضريبة قبل المرتجعات')}
        ${statCard('عدد الفواتير', fmtInt(k.count), 'green', 'orders')}
        ${statCard('متوسط الفاتورة', fmtMoney(k.avg), 'amber', 'chart')}
        ${statCard('الربح الإجمالي التقديري', fmtMoney(k.grossProfit), 'green', 'up', 'صافي المبيعات − تكلفة البضاعة')}
        ${statCard('إجمالي المرتجعات', fmtMoney(k.refundTotal), 'red', 'refunds', `${fmtInt(refunds.length)} عملية`)}
        ${statCard('تنبيهات المخزون', fmtInt(low.length), low.length ? 'red' : 'gray', 'alert', 'أصناف تحت الحد الأدنى')}
      </div>
      <div class="grid g-main mb-14">
        <div class="card"><div class="card-h"><span>المبيعات اليومية</span><span class="muted sm">${UI.dash.period === 'today' ? 'اليوم' : 'حسب اليوم'}</span></div>
          <div class="card-b">${days.length > 1 ? lineChart(days) : `<div class="center" style="padding:20px"><div class="bold" style="font-size:28px">${fmtMoney(k.total)}</div><div class="muted">مبيعات اليوم — اختر فترة أطول لعرض المخطط</div></div>`}</div></div>
        <div class="card"><div class="card-h">طرق الدفع</div><div class="card-b">${donutChart(Object.entries(pay).map(([m, v]) => ({ label: METHOD_LABEL[m] || m, value: v })))}</div></div>
      </div>
      <div class="grid g3 mb-14">
        <div class="card"><div class="card-h">الوردية الحالية ${shiftBadge()}</div><div class="card-b">${sh && sm ? `
          <div class="kv"><span>الكاشير</span><b>${esc(sh.cashier)}</b></div>
          <div class="kv"><span>بدأت</span><span>${dt(sh.openedAt)}</span></div>
          <div class="kv"><span>عدد الفواتير</span><b class="num">${fmtInt(sm.orders)}</b></div>
          <div class="kv"><span>مبيعات الوردية</span><b class="num">${fmtMoney(sm.sales)}</b></div>` : emptyState('لا توجد وردية مفتوحة', '🔒')}</div></div>
        <div class="card"><div class="card-h">ملخص الخزنة (نقدي فقط)</div><div class="card-b">${sh && sm ? `
          <div class="kv"><span>رصيد الافتتاح</span><span class="num">${fmtMoney(sh.openingCash)}</span></div>
          <div class="kv"><span>مبيعات نقدية</span><span class="num">${fmtMoney(sm.by.cash)}</span></div>
          <div class="kv"><span>إيداعات − سحوبات</span><span class="num">${fmtMoney(sm.deposits - sm.withdrawals)}</span></div>
          <div class="kv"><span>مرتجعات نقدية ومصروفات نقدية</span><span class="num">−${fmtMoney(sm.cashRefunds + sm.cashExpenses)}</span></div>
          <div class="kv total"><span>النقدية المتوقعة</span><span class="num">${fmtMoney(sm.expected)}</span></div>` : emptyState('افتح وردية لعرض الخزنة', '💵')}</div></div>
        <div class="card"><div class="card-h">الأكثر مبيعًا</div><div class="card-b">${barList(top.map((t) => ({ label: `${t.emoji} ${t.name}`, value: t.qty })), (v) => fmtInt(v))}</div></div>
      </div>
      <div class="grid g-main">
        <div class="card"><div class="card-h">آخر الفواتير</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الفاتورة</th><th>النوع</th><th>الوقت</th><th>الدفع</th><th>الإجمالي</th></tr></thead><tbody>
          ${recent.map((o) => `<tr><td class="bold">${esc(o.no)}</td><td>${ORDER_TYPES[o.type]}${o.tableId ? ` — ط${fmtInt(o.tableId)}` : ''}</td><td>${dt(o.paidAt)}</td><td>${o.payments.map((p) => METHOD_LABEL[p.method]).join(' + ')}</td><td class="num bold">${fmtMoney(o.total)}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('لا توجد فواتير')}</td></tr>`}
        </tbody></table></div></div>
        <div class="card"><div class="card-h">مخزون منخفض</div><div class="card-b">${low.length ? low.slice(0, 7).map((i) => `<div class="kv"><span>${esc(i.name)}</span><span class="neg-num num">${fmtQty(i.qty)} ${BASE_UNIT_LABEL[i.baseUnit]} / ${fmtQty(i.minQty)}</span></div>`).join('') : emptyState('كل الأصناف فوق الحد الأدنى', '✅')}</div></div>
      </div>
      <div class="muted xs mt-14">الربح الإجمالي التقديري = صافي المبيعات بدون ضريبة − تكلفة المكونات (لقطة التكلفة وقت البيع). الضريبة المحصّلة (${fmtMoney(k.tax)}) ليست إيرادًا. المصروفات التشغيلية للفترة: ${fmtMoney(k.expenses)}.</div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { UI.dash.period = b.dataset.period; render(); }));
    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  },
};

// ===== 70-sales-pages.js =====
// ---------------------------------------------------------------------------
// الطاولات — الطلبات — الأصناف — التصنيفات
// ---------------------------------------------------------------------------
function guardCartReplace(orderId, then) {
  if (S.cart.items.length && S.cart.orderId !== orderId) {
    confirmDialog({ title: 'استبدال الفاتورة الحالية', message: 'يوجد طلب غير محفوظ في الكاشير. سيتم استبداله. هل تريد المتابعة؟', confirmText: 'متابعة', onConfirm: then });
  } else then();
}

// ===== الطاولات =====
const TABLE_LABEL = { free: 'متاحة', busy: 'مشغولة', wait: 'بانتظار الدفع', res: 'محجوزة' };

PAGES.tables = {
  render() {
    const cards = S.tables.map((tb) => {
      const st = tableState(S, tb.number);
      const o = st.order;
      return `<button class="tcard s-${st.status}" data-table="${tb.number}">
        <span class="tn">T${fmtInt(tb.number)}</span>
        <span class="tt">${TABLE_LABEL[st.status]}</span>
        ${o ? `<span class="num">${fmtMoney(o.total)}</span><span class="xs"><span data-since="${o.createdAt}">${fmtElapsed(minutesSince(o.createdAt))}</span> ساعة:دقيقة</span>` : `<span class="xs">${fmtInt(tb.seats)} مقاعد</span>`}
      </button>`;
    }).join('');
    const counts = { free: 0, busy: 0, wait: 0, res: 0 };
    S.tables.forEach((t) => { counts[tableState(S, t.number).status] += 1; });
    return `${pageHead('إدارة الطاولات', `<button class="btn btn-primary" data-add-tables>${icon('plus')} إضافة طاولات</button>`)}
      <div class="legend-row">${[['free', 'متاحة', '#12a150'], ['busy', 'مشغولة', '#e5484d'], ['wait', 'بانتظار الدفع', '#f59e0b'], ['res', 'محجوزة', '#8a97b1']].map(([k, l, c]) => `<span><i style="background:${c}"></i>${l} (${fmtInt(counts[k])})</span>`).join('')}</div>
      <div class="tbl-grid">${cards}</div>
      <div class="muted xs mt-14">الحالات تُحسب من الطلبات المفتوحة في بيانات العرض، وتتزامن مع شاشة الكاشير والطلبات.</div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => openTableDialog(Number(b.dataset.table))));
    const at = root.querySelector('[data-add-tables]');
    if (at) at.addEventListener('click', openAddTables);
  },
};

function openAddTables() {
  openModal({
    title: 'إضافة طاولات', size: 'sm',
    body: `<div class="col">${field('عدد الطاولات الجديدة', '<input class="input" name="n" type="number" min="1" max="100" value="5">')}${field('عدد المقاعد لكل طاولة', '<input class="input" name="seats" type="number" min="1" max="30" value="4">')}<div class="hint">العدد الحالي: ${fmtInt(S.tables.length)} طاولة. الحد الأقصى 200.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>إضافة</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const n = Number(d.n); const seats = Number(d.seats);
        if (!Number.isInteger(n) || n < 1 || n > 100) return markInvalid(el, 'n', 'من 1 إلى 100');
        if (!Number.isInteger(seats) || seats < 1 || seats > 30) return markInvalid(el, 'seats', 'من 1 إلى 30');
        if (S.tables.length + n > 200) return markInvalid(el, 'n', 'الحد الأقصى 200 طاولة');
        close();
        commit((s) => { let max = s.tables.reduce((m, t) => Math.max(m, t.number), 0); for (let i = 0; i < n; i += 1) { max += 1; s.tables.push({ number: max, seats, reserved: false }); } });
        toast(`تمت إضافة ${fmtInt(n)} طاولة`, 'ok');
      });
    },
  });
}

function guardOrdersFree(...ids) { return ids.some((id) => id && S.cart.orderId === id); }
const sameLine = (a, b) => !a.weightG && !b.weightG && a.productId === b.productId && optionsSignature(a.options) === optionsSignature(b.options) && (a.note || '') === (b.note || '');

function rebuildOrder(s, ord, items) {
  const mk = (disc) => ({
    items: items.map((i) => ({ weightG: i.weightG || 0, pricePerKg: i.pricePerKg || 0, key: i.key, productId: i.productId, name: i.name, emoji: i.emoji, tone: i.tone, image: i.image || '', basePrice: i.basePrice, options: i.options, qty: i.qty, note: i.note || '', taxExempt: !!i.taxExempt })),
    type: ord.type, tableId: ord.tableId, note: ord.note, customerId: ord.customerId, orderId: ord.id, discount: disc, delivery: ord.delivery,
  });
  const d = ord.discount || {};
  let disc = { type: d.type, value: d.value, reason: d.reason || '', approvedBy: d.approvedBy || '' };
  let comp;
  try { comp = composeOrder(s, mk(disc), items); } catch (e) { disc = { type: null, value: 0, reason: '', approvedBy: '' }; comp = composeOrder(s, mk(disc), items); }
  const t = comp.totals;
  Object.assign(ord, {
    items: comp.items, subtotal: t.subtotal, discountAmount: t.discountAmount, taxAmount: t.taxAmount, netSales: t.netSales, total: t.total,
    deliveryFee: t.deliveryFee || 0, cogs: comp.cogs, discount: { type: t.discountType, value: t.discountValue, reason: disc.reason, approvedBy: disc.approvedBy }, updatedAt: new Date().toISOString(),
  });
}

function moveItems(srcId, lines, destNo) {
  const dstExisting = activeOrderForTable(S, destNo);
  if (guardOrdersFree(srcId, dstExisting && dstExisting.id)) return toast('أحد الطلبين مفتوح الآن في الكاشير — احفظه أولًا', 'err');
  commit((s) => {
    const src = s.orders.find((o) => o.id === srcId);
    const srcItems = clone(src.items);
    const moved = [];
    lines.forEach(({ key, qty }) => {
      const it = srcItems.find((i) => i.key === key);
      const sent = Math.min(qty, it.kitchenQty || 0);
      moved.push({ ...clone(it), key: qty === it.qty ? it.key : uid('ci'), qty, kitchenQty: sent, refundedQty: 0, refundedAmount: 0 });
      it.qty -= qty;
      it.kitchenQty = (it.kitchenQty || 0) - sent;
    });
    let dst = activeOrderForTable(s, destNo);
    if (!dst) {
      dst = makeOrder(s, { items: [], type: 'dine_in', tableId: destNo, note: '', customerId: src.customerId, orderId: null, discount: { type: null, value: 0, reason: '', approvedBy: '' }, delivery: null }, { status: 'pending', cashier: currentUser().name });
      s.orders.push(dst);
    }
    const dstItems = clone(dst.items);
    moved.forEach((m) => {
      const same = dstItems.find((i) => sameLine(i, m));
      if (same) { same.qty += m.qty; same.kitchenQty = (same.kitchenQty || 0) + m.kitchenQty; } else dstItems.push(m);
    });
    rebuildOrder(s, dst, dstItems);
    const remaining = srcItems.filter((i) => i.qty > 0);
    if (remaining.length) rebuildOrder(s, src, remaining);
    else { src.status = 'cancelled'; src.mergedInto = dst.id; src.note = `${src.note ? `${src.note} | ` : ''}نُقلت كل الأصناف إلى طاولة ${destNo} (${dst.no})`; src.updatedAt = new Date().toISOString(); }
    audit('نقل أصناف', `من طاولة ${src.tableId} (${src.no}) إلى طاولة ${destNo} (${dst.no}) — ${moved.map((m) => `${m.name} ×${m.qty}`).join('، ')}`);
  });
  toast(`تم نقل الأصناف إلى الطاولة ${fmtInt(destNo)}`, 'ok');
}

function mergeOrders(srcId, dstId) {
  if (guardOrdersFree(srcId, dstId)) return toast('أحد الطلبين مفتوح الآن في الكاشير — احفظه أولًا', 'err');
  commit((s) => {
    const a = s.orders.find((o) => o.id === srcId);
    const b = s.orders.find((o) => o.id === dstId);
    const items = clone(b.items);
    clone(a.items).forEach((m) => {
      const same = items.find((i) => sameLine(i, m));
      if (same) { same.qty += m.qty; same.kitchenQty = (same.kitchenQty || 0) + (m.kitchenQty || 0); } else items.push(m);
    });
    b.note = [b.note, a.note].filter(Boolean).join(' | ');
    b.customerId = b.customerId || a.customerId;
    rebuildOrder(s, b, items);
    a.status = 'cancelled'; a.mergedInto = b.id; a.note = `${a.note ? `${a.note} | ` : ''}دُمج في ${b.no} (طاولة ${b.tableId})`; a.updatedAt = new Date().toISOString();
    audit('دمج طاولات', `طاولة ${a.tableId} (${a.no}) ← طاولة ${b.tableId} (${b.no})`);
  });
  toast('تم دمج الطاولتين', 'ok');
}

function openMoveItems(o) {
  const dests = S.tables.filter((t) => t.number !== o.tableId && tableState(S, t.number).status !== 'res');
  openModal({
    title: `نقل أصناف من الطاولة ${fmtInt(o.tableId)}`, size: 'lg',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الصنف</th><th>الكمية</th><th>كمية النقل</th></tr></thead><tbody>${o.items.map((i) => `<tr><td>${i.emoji} ${esc(i.name)}${i.options.length ? `<div class="muted xs">${i.options.map((x) => esc(x.name)).join('، ')}</div>` : ''}</td><td class="num">${fmtInt(i.qty)}</td><td><input class="input" style="width:80px" type="number" min="0" max="${i.qty}" value="0" data-mq="${i.key}"></td></tr>`).join('')}</tbody></table></div>
      <div class="mt-14">${field('الطاولة المنقول إليها', `<select class="select" name="dest"><option value="">اختر الطاولة</option>${dests.map((t) => { const st = tableState(S, t.number); return `<option value="${t.number}">طاولة ${fmtInt(t.number)} — ${st.order ? `مشغولة (${st.order.no})` : 'فاضية'}</option>`; }).join('')}</select>`)}</div>
      <div class="hint mt-8">لو الطاولة فاضية يُنشأ طلب جديد عليها. لو مشغولة تُضاف الأصناف لطلبها. حالة «أُرسل للمطبخ» تنتقل مع الصنف.</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>نقل</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const dest = Number(el.querySelector('[name=dest]').value);
        if (!dest) return markInvalid(el, 'dest', 'اختر الطاولة');
        const lines = [];
        for (const inp of el.querySelectorAll('[data-mq]')) {
          const q = Number(inp.value);
          const it = o.items.find((i) => i.key === inp.dataset.mq);
          if (!Number.isInteger(q) || q < 0 || q > it.qty) return toast(`كمية غير صحيحة للصنف ${it.name}`, 'err');
          if (q > 0) lines.push({ key: it.key, qty: q });
        }
        if (!lines.length) return toast('حدد كمية صنف واحد على الأقل', 'err');
        close();
        moveItems(o.id, lines, dest);
      });
    },
  });
}

function openMergeTables(o) {
  const others = S.orders.filter((x) => (x.status === 'pending' || x.status === 'held') && x.type === 'dine_in' && x.tableId && x.id !== o.id);
  if (!others.length) return toast('لا توجد طاولة أخرى عليها طلب مفتوح للدمج', 'warn');
  openModal({
    title: `دمج الطاولة ${fmtInt(o.tableId)} مع طاولة أخرى`, size: 'sm',
    body: `<div class="col">${field('دمج في الطاولة', `<select class="select" name="dst">${others.map((x) => `<option value="${x.id}">طاولة ${fmtInt(x.tableId)} — ${esc(x.no)} (${fmtMoney(x.total)})</option>`).join('')}</select>`)}
      <div class="hint">تُنقل كل أصناف طاولة ${fmtInt(o.tableId)} إلى الطاولة المختارة وتُحرَّر ${fmtInt(o.tableId)}.${o.discountAmount ? ' ⚠ خصم هذا الطلب لن يُنقل.' : ''}</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>دمج</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => { const id = el.querySelector('[name=dst]').value; close(); mergeOrders(o.id, id); });
    },
  });
}

function openTableDialog(n) {
  const st = tableState(S, n);
  const meta = S.tables.find((t) => t.number === n);
  const o = st.order;
  const body = o
    ? `<div class="kv"><span>الطلب</span><b>${esc(o.no)}</b></div><div class="kv"><span>الحالة</span><span>${TABLE_LABEL[st.status]}</span></div>
       <div class="kv"><span>مدة الطلب</span><span class="num">${fmtElapsed(minutesSince(o.createdAt))}</span></div>
       ${o.items.map((i) => `<div class="kv"><span>${esc(i.name)} × ${fmtInt(i.qty)}${i.options.length ? `<div class="muted xs">${i.options.map((x) => esc(x.name)).join('، ')}</div>` : ''}</span><span class="num">${fmtMoney(i.lineTotal)}</span></div>`).join('')}
       <div class="kv total"><span>الإجمالي</span><span class="num">${fmtMoney(o.total)}</span></div>
       ${o.note ? `<div class="kv"><span>📝 ملاحظة</span><span>${esc(o.note)}</span></div>` : ''}`
    : st.status === 'res' ? '<p>الطاولة محجوزة. يمكنك إلغاء الحجز أو فتح طلب عليها.</p>' : '<p>الطاولة متاحة. افتح طلبًا جديدًا ثم أضف الأصناف من شاشة الكاشير.</p>';
  openModal({
    title: `الطاولة ${fmtInt(n)} — ${TABLE_LABEL[st.status]}`, size: 'sm', body,
    footer: o
      ? `<button class="btn" data-close>رجوع للطاولات</button>
         <button class="btn btn-danger" data-cancel>إلغاء الطلب وإغلاق الطاولة</button>
         <button class="btn" data-wait>${o.awaitingPayment ? 'إلغاء «بانتظار الدفع»' : 'تعليم: بانتظار الدفع'}</button>
         <button class="btn" data-move>نقل أصناف</button>
         <button class="btn" data-merge>دمج مع طاولة</button>
         <button class="btn btn-primary" data-open>فتح الطلب / إضافة أصناف</button>`
      : `<button class="btn" data-close>رجوع</button>
         ${st.status === 'res' ? '<button class="btn" data-unres>إلغاء الحجز</button>' : '<button class="btn" data-res>حجز الطاولة</button>'}
         ${can('catalog.edit') ? '<button class="btn btn-danger" data-del>حذف الطاولة</button>' : ''}
         <button class="btn btn-primary" data-new>فتح طلب جديد</button>`,
    onMount(el, close) {
      const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.addEventListener('click', fn); };
      on('[data-open]', () => guardCartReplace(o.id, () => { close(); openOrderInCart(o.id); go('cashier'); }));
      on('[data-wait]', () => { close(); setAwaitingPayment(o.id, !o.awaitingPayment); });
      on('[data-move]', () => { close(); openMoveItems(o); });
      on('[data-merge]', () => { close(); openMergeTables(o); });
      on('[data-cancel]', () => { close(); confirmDialog({ title: 'إلغاء الطلب', message: `سيتم إلغاء الطلب ${esc(o.no)} وتحرير الطاولة. لن يتم خصم أي مخزون. متابعة؟`, confirmText: 'إلغاء الطلب', danger: true, onConfirm: () => requestCancel(o, 'إلغاء من شاشة الطاولات') }); });
      on('[data-new]', () => guardCartReplace(null, () => { close(); commit((s) => { s.cart = emptyCart(); s.cart.type = 'dine_in'; s.cart.tableId = n; }, { silent: true }); go('cashier'); }));
      on('[data-res]', () => { close(); commit((s) => { s.tables.find((t) => t.number === n).reserved = true; }); });
      on('[data-unres]', () => { close(); commit((s) => { s.tables.find((t) => t.number === n).reserved = false; }); });
      on('[data-del]', () => { close(); confirmDialog({ title: 'حذف الطاولة', message: `حذف الطاولة ${fmtInt(n)}؟ الفواتير القديمة لا تتأثر.`, confirmText: 'حذف', danger: true, onConfirm: () => commit((s) => { s.tables = s.tables.filter((t) => t.number !== n); }) }); });
    },
  });
  void meta;
}

// ===== الطلبات =====
function payState(o) {
  if (o.status === 'cancelled') return ['ملغي', 'gray'];
  if (o.status !== 'completed') return ['غير مدفوع', 'amber'];
  const rs = refundState(o);
  if (rs === 'full') return ['مسترجع بالكامل', 'red'];
  if (rs === 'partial') return ['مدفوع — مرتجع جزئي', 'blue'];
  return ['مدفوع', 'green'];
}
const STATUS_KIND = { pending: 'blue', held: 'amber', completed: 'green', cancelled: 'gray' };

PAGES.orders = {
  render() {
    const id = 'orders';
    const stt = (tableStates[id] = tableStates[id] || { q: '', sort: 3, dir: -1, page: 1, f: {} });
    stt.f = stt.f || {};
    const f = stt.f;
    let rows = S.orders.slice();
    if (f.status) rows = rows.filter((o) => (f.status === 'refunded' ? o.status === 'completed' && refundState(o) !== 'none' : o.status === f.status));
    if (f.type) rows = rows.filter((o) => o.type === f.type);
    if (f.from) rows = rows.filter((o) => dayKey(o.createdAt) >= f.from);
    if (f.to) rows = rows.filter((o) => dayKey(o.createdAt) <= f.to);
    const filters = `${tblSelectFilter(id, 'status', 'كل الحالات', [['pending', 'قيد التنفيذ'], ['held', 'معلّق'], ['completed', 'مكتمل'], ['cancelled', 'ملغي'], ['refunded', 'به مرتجع']])}
      ${tblSelectFilter(id, 'type', 'كل الأنواع', Object.entries(ORDER_TYPES))}
      <input class="input" type="date" style="width:auto" data-date="from" value="${f.from || ''}" title="من تاريخ">
      <input class="input" type="date" style="width:auto" data-date="to" value="${f.to || ''}" title="إلى تاريخ">`;
    return `${pageHead('الطلبات والفواتير')}${demoNote('الفواتير والطلبات هنا بيانات عرض محفوظة في المتصفح فقط.')}
      ${dataTable({
        id, rows, pageSize: 12, filtersHtml: filters, empty: 'لا توجد طلبات مطابقة',
        search: (o) => `${o.no} ${o.tableId || ''} ${customerName(o.customerId)} ${o.cashier} ${o.note || ''} ${o.delivery ? `${o.delivery.phone} ${o.delivery.address}` : ''}`,
        columns: [
          { label: 'الفاتورة', render: (o) => `<b>${esc(o.no)}</b>${o.demo ? '' : ' <span class="badge b-blue">جديد</span>'}`, sort: (o) => o.no },
          { label: 'النوع', render: (o) => ORDER_TYPES[o.type], sort: (o) => o.type },
          { label: 'الطاولة', render: (o) => (o.tableId ? fmtInt(o.tableId) : '—') },
          { label: 'وقت الإنشاء', render: (o) => dt(o.createdAt), sort: (o) => o.createdAt },
          { label: 'الإجمالي', render: (o) => `<span class="num bold">${fmtMoney(o.total)}</span>`, sort: (o) => o.total },
          { label: 'الدفع', render: (o) => { const [t, k] = payState(o); return badge(t, k); } },
          { label: 'الحالة', render: (o) => badge(STATUS_LABEL[o.status], STATUS_KIND[o.status]), sort: (o) => o.status },
          { label: 'ملاحظة', render: (o) => (o.note ? `<span class="ellipsis" style="max-width:160px;display:inline-block;color:var(--amber)" title="${esc(o.note)}">📝 ${esc(o.note)}</span>` : '—') },
          { label: '', render: (o) => `<div class="actions"><button class="btn btn-sm" data-act="view">${icon('eye')} عرض</button>${o.status === 'pending' || o.status === 'held' ? '<button class="btn btn-sm btn-success" data-act="pay">دفع</button><button class="btn btn-sm btn-primary" data-act="open">فتح</button>' : ''}</div>` },
        ],
      })}`;
  },
  bind(root) {
    bindTable(root, 'orders', (act, o) => {
      if (act === 'view') showOrderDetails(o);
      if (act === 'open') guardCartReplace(o.id, () => { openOrderInCart(o.id); go('cashier'); });
      if (act === 'pay') guardCartReplace(o.id, () => { openOrderInCart(o.id); go('cashier'); setTimeout(openPaymentDialog, 120); });
    });
    bindFilters(root);
    root.querySelectorAll('[data-date]').forEach((i) => i.addEventListener('change', () => { tableStates.orders.f[i.dataset.date] = i.value; tableStates.orders.page = 1; render(); }));
  },
};

function showOrderDetails(o) {
  const [pt, pk] = payState(o);
  const refunds = S.refunds.filter((r) => r.orderId === o.id);
  openModal({
    title: `الطلب ${esc(o.no)}`, size: 'lg',
    body: `<div class="row wrap mb-14">${badge(STATUS_LABEL[o.status], STATUS_KIND[o.status])} ${badge(pt, pk)} <span class="muted">${ORDER_TYPES[o.type]}${o.tableId ? ` — طاولة ${fmtInt(o.tableId)}` : ''} • ${dt(o.createdAt)} • ${esc(o.cashier)}${o.customerId ? ` • ${esc(customerName(o.customerId))}` : ''}</span></div>
      ${o.delivery ? `<div class="demo-note" style="background:var(--primary-l);border-color:var(--primary);color:var(--text)">📞 <b class="ltr">${esc(o.delivery.phone)}</b>${o.delivery.name ? ` — ${esc(o.delivery.name)}` : ''} &nbsp; 📍 ${esc(o.delivery.address)}${o.deliveryFee ? ` &nbsp; رسوم التوصيل: ${fmtMoney(o.deliveryFee)}` : ''}</div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الصنف</th><th>الخيارات</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th><th>مسترجع</th></tr></thead><tbody>
      ${o.items.map((i) => `<tr><td>${i.emoji} ${esc(i.name)}${i.note ? `<div class="muted xs">📝 ${esc(i.note)}</div>` : ''}</td><td class="muted sm">${i.options.map((x) => esc(x.name)).join('، ') || '—'}</td><td class="num">${fmtInt(i.qty)}</td><td class="num">${fmtMoney(i.unitPrice)}</td><td class="num">${fmtMoney(i.lineTotal)}</td><td class="num">${i.refundedQty ? `${fmtInt(i.refundedQty)} (${fmtMoney(i.refundedAmount)})` : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="grid g2 mt-14"><div>
        <div class="kv"><span>المجموع الفرعي</span><span class="num">${fmtMoney(o.subtotal)}</span></div>
        <div class="kv"><span>الخصم</span><span class="num">${fmtMoney(o.discountAmount)}</span></div>
        <div class="kv"><span>الضريبة (لقطة وقت البيع: ${o.taxSnapshot.enabled ? fmtPct(o.taxSnapshot.rateBps / 100) : 'معطلة'})</span><span class="num">${fmtMoney(o.taxAmount)}</span></div>
        <div class="kv total"><span>الإجمالي</span><span class="num">${fmtMoney(o.total)}</span></div></div>
        <div>${o.payments.length ? o.payments.map((p) => `<div class="kv"><span>${METHOD_ICON[p.method] || ''} ${METHOD_LABEL[p.method] || p.method}</span><span class="num">${fmtMoney(p.amount)}</span></div>`).join('') + (o.change ? `<div class="kv"><span>الباقي للعميل</span><span class="num">${fmtMoney(o.change)}</span></div>` : '') : '<div class="muted">لا توجد مدفوعات</div>'}
        ${refunds.map((r) => `<div class="kv"><span>مرتجع ${esc(r.ref)}</span><span class="num neg-num">−${fmtMoney(r.amount)}</span></div>`).join('')}
        ${o.note ? `<div class="kv"><span>ملاحظة</span><span>${esc(o.note)}</span></div>` : ''}</div></div>`,
    footer: `<button class="btn" data-close>إغلاق</button>
      ${o.status === 'completed' ? `<button class="btn btn-primary" data-receipt>${icon('print')} إيصال / معاينة</button>` : ''}
      ${o.status === 'pending' || o.status === 'held' ? '<button class="btn btn-danger" data-cancel>إلغاء الطلب</button><button class="btn btn-primary" data-open>فتح / تعديل</button>' : ''}`,
    onMount(el, close) {
      const on = (s, fn) => { const b = el.querySelector(s); if (b) b.addEventListener('click', fn); };
      on('[data-receipt]', () => { close(); showReceipt(o); });
      on('[data-open]', () => guardCartReplace(o.id, () => { close(); openOrderInCart(o.id); go('cashier'); }));
      on('[data-cancel]', () => { close(); confirmDialog({ title: 'إلغاء الطلب', message: `إلغاء الطلب ${esc(o.no)}؟`, confirmText: 'إلغاء الطلب', danger: true, onConfirm: () => requestCancel(o, 'إلغاء من شاشة الطلبات') }); });
    },
  });
}

// ===== الأصناف =====
function compressImage(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 240;
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => toast('تعذر قراءة الصورة', 'err');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

PAGES.products = {
  render() {
    const id = 'products';
    tableStates[id] = tableStates[id] || { q: '', sort: null, dir: 1, page: 1, f: {} };
    const f = tableStates[id].f || (tableStates[id].f = {});
    let rows = S.products.slice();
    if (f.cat) rows = rows.filter((p) => p.categoryId === f.cat);
    if (f.active) rows = rows.filter((p) => String(p.active) === f.active);
    const edit = can('catalog.edit');
    const sp = salesByProduct();
    return `${pageHead('إدارة الأصناف', `<button class="btn" data-recv-prod ${edit ? '' : 'disabled'}>${icon('download')} استلام بضاعة</button><button class="btn" data-menu-open>${icon('eye')} شاشة المنيو للزبون</button><button class="btn" data-menu-export>${icon('download')} تصدير المنيو الإلكتروني</button><button class="btn btn-primary" data-add ${edit ? '' : 'disabled title="لا تملك صلاحية التعديل"'}>${icon('plus')} إضافة صنف</button>`)}
      ${dataTable({
        id, rows, pageSize: 10, empty: 'لا توجد أصناف',
        filtersHtml: `${tblSelectFilter(id, 'cat', 'كل التصنيفات', S.categories.map((c) => [c.id, c.name]))}${tblSelectFilter(id, 'active', 'كل الحالات', [['true', 'نشط'], ['false', 'غير نشط']])}`,
        search: (p) => `${p.name} ${p.sku}`,
        columns: [
          { label: 'الصورة', render: (p) => `<div class="thumb tone-${p.tone}" style="${p.image ? `background-image:url('${esc(p.image)}');background-size:cover` : ''}">${p.image ? '' : p.emoji}</div>` },
          { label: 'الاسم', render: (p) => `<b>${esc(p.name)}</b>`, sort: (p) => p.name },
          { label: 'التصنيف', render: (p) => esc(categoryName(p.categoryId)), sort: (p) => categoryName(p.categoryId) },
          { label: 'SKU', render: (p) => `<span class="ltr">${esc(p.sku)}</span>` },
          { label: 'السعر', render: (p) => `<span class="num">${fmtMoney(p.price)}</span>${isWeight(p) ? ' / كجم' : ''}${p.costPrice ? `<div class="muted xs">شراء ${fmtMoney(p.costPrice)}</div>` : ''}`, sort: (p) => p.price },
          { label: 'المخزون', render: (p) => (p.stockMode === 'direct' ? badge(stockLabelDirect(p), (p.stockQty || 0) <= (p.minQty || 0) ? 'red' : 'green') : p.stockMode === 'recipe' ? badge('حسب الوصفة', 'blue') : badge('بدون تتبع', 'gray')) },
          { label: 'تم بيعه', render: (p) => { const e = sp.get(p.id); return e ? `<b class="num">${fmtInt(e.qty)}</b> مرة<div class="muted xs">${fmtInt(e.orders)} فاتورة${e.grams ? ` • ${fmtQty(e.grams / 1000)} كجم` : ''}</div>` : '<span class="muted">لم يُبع بعد</span>'; }, sort: (p) => (sp.get(p.id) || { qty: 0 }).qty },
          { label: 'الحالة', render: (p) => (p.active ? badge('نشط', 'green') : badge('غير نشط', 'gray')), sort: (p) => p.active },
          { label: '', render: () => `<div class="actions"><button class="btn btn-sm" data-act="edit" ${edit ? '' : 'disabled'}>${icon('edit')}</button><button class="btn btn-sm" data-act="toggle" ${edit ? '' : 'disabled'}>تفعيل/تعطيل</button></div>` },
        ],
      })}`;
  },
  bind(root) {
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', () => openProductForm(null));
    const rp = root.querySelector('[data-recv-prod]');
    if (rp) rp.addEventListener('click', openReceiveProduct);
    const mo = root.querySelector('[data-menu-open]');
    if (mo) mo.addEventListener('click', () => window.open(`${location.href.split('#')[0]}#/menu`, '_blank'));
    const mx = root.querySelector('[data-menu-export]');
    if (mx) mx.addEventListener('click', exportMenu);
    bindTable(root, 'products', (act, p) => {
      if (act === 'edit') openProductForm(p);
      if (act === 'toggle') { commit((s) => { const x = s.products.find((y) => y.id === p.id); x.active = !x.active; }); toast(p.active ? 'تم تعطيل الصنف (لا يُحذف لأنه مرتبط بفواتير سابقة)' : 'تم تفعيل الصنف', 'ok'); }
    });
    bindFilters(root);
  },
};

function exportMenu() {
  const cats = S.categories.filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const secs = cats.map((c) => {
    const ps = S.products.filter((p) => p.active && p.categoryId === c.id);
    if (!ps.length) return '';
    return `<h2>${esc(c.icon)} ${esc(c.name)}</h2><div class="g">${ps.map((p) => `<div class="i"><div class="e">${p.image ? `<img src="${esc(p.image)}" alt="">` : esc(p.emoji)}</div><b>${esc(p.name)}</b><span>${fmtNum(p.price)} ج.م</span></div>`).join('')}</div>`;
  }).join('');
  const t = S.settings.tax;
  const note = t.enabled && t.mode === 'exclusive' ? `الأسعار لا تشمل الضريبة (${t.ratePct}%)` : '';
  const css = 'body{font-family:Cairo,Tahoma,sans-serif;margin:0;padding:16px;background:#eef3fb;color:#14234a}h1{text-align:center}h2{margin:22px 0 10px;border-bottom:2px solid #1f6feb;padding-bottom:4px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.i{background:#fff;border-radius:14px;padding:10px;text-align:center;box-shadow:0 2px 8px #0001;display:flex;flex-direction:column;gap:4px}.e{font-size:38px;height:70px;display:grid;place-items:center}.e img{max-width:100%;max-height:70px;border-radius:10px}.i span{color:#1f6feb;font-weight:700}.f{text-align:center;color:#6b7a99;font-size:13px}@media(prefers-color-scheme:dark){body{background:#0a1224;color:#e7edfb}.i{background:#111d38}}';
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(S.settings.business.name)} — المنيو</title><style>${css}</style></head><body><h1>${esc(S.settings.business.name)}</h1>${secs}<p class="f">${esc(note)}</p></body></html>`;
  downloadFile('menu.html', html, 'text/html;charset=utf-8');
  toast('تم تنزيل المنيو (نسخة ثابتة — أعد التصدير بعد أي تغيير في الأسعار)', 'ok');
}

function salesByProduct() {
  const m = new Map();
  S.orders.forEach((o) => {
    if (o.status !== 'completed') return;
    o.items.forEach((it) => {
      const net = it.qty - (it.refundedQty || 0);
      if (net <= 0) return;
      const e = m.get(it.productId) || { qty: 0, grams: 0, ids: new Set() };
      e.qty += net; if (it.weightG) e.grams += it.weightG * net; e.ids.add(o.id);
      m.set(it.productId, e);
    });
  });
  m.forEach((e) => { e.orders = e.ids.size; });
  return m;
}

function uomTableHtml() {
  const edit = can('settings.edit');
  const rows = S.uoms.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td class="ltr">${esc(u.abbr)}</td><td>${UOM_TYPE_LABEL[u.type]}</td><td class="num">${TYPE_BASE[u.type] ? `${fmtQty(u.factor)} ${BASE_UNIT_LABEL[TYPE_BASE[u.type]]}` : 'حسب الخامة'}</td><td class="num">${fmtInt(u.decimals)}</td><td>${u.active ? badge('مفعّلة', 'green') : badge('معطّلة', 'gray')}</td><td><div class="actions"><button class="btn btn-sm" data-uom-edit="${u.id}" ${edit ? '' : 'disabled'}>${icon('edit')}</button></div></td></tr>`).join('');
  return `<div class="row between mb-8"><div class="hint">تعطيل وحدة لا يؤثر على الوصفات والحركات القديمة. تحويلات التعبئة والتحضير تُعرَّف لكل خامة من «المخزون ← الوحدات».</div><button class="btn btn-primary" data-uom-add ${edit ? '' : 'disabled'}>${icon('plus')} إضافة وحدة</button></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوحدة</th><th>الاختصار</th><th>النوع</th><th>المعامل</th><th>المنازل العشرية</th><th>الحالة</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function openUomForm(u) {
  if (!can('settings.edit')) return toast('غير مصرّح', 'err');
  const isNew = !u;
  const cur = u || { name: '', abbr: '', type: 'weight', factor: 1, decimals: 3, active: true, builtin: false };
  openModal({
    title: isNew ? 'إضافة وحدة قياس' : `تعديل: ${esc(cur.name)}`, size: 'sm',
    body: `<div class="col">${field('الاسم *', `<input class="input" name="name" value="${esc(cur.name)}">`)}${field('الاختصار *', `<input class="input" name="abbr" value="${esc(cur.abbr)}">`)}${field('النوع', `<select class="select" name="type" ${isNew ? '' : 'disabled'}>${Object.entries(UOM_TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${cur.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}<div id="ff">${field('المعامل (بالوحدة الأساسية: جرام / مللي / قطعة)', `<input class="input" name="factor" inputmode="decimal" value="${cur.factor == null ? '' : cur.factor}" ${cur.builtin ? 'disabled' : ''}>`)}</div>${field('المنازل العشرية المسموحة', `<input class="input" name="decimals" type="number" min="0" max="6" value="${cur.decimals}">`)}<label class="check"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> مفعّلة</label><div class="hint">معامل الوحدات الأساسية الجاهزة لا يُعدَّل. وحدات التعبئة والتحضير يُحدَّد مقدارها لكل خامة.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const typeEl = el.querySelector('[name=type]');
      const sync = () => el.querySelector('#ff').classList.toggle('hidden', !TYPE_BASE[typeEl.value]);
      typeEl.addEventListener('change', sync); sync();
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const type = isNew ? d.type : cur.type;
        const name = d.name.trim(); const abbr = d.abbr.trim();
        if (!name) return markInvalid(el, 'name', 'الاسم مطلوب');
        if (!abbr) return markInvalid(el, 'abbr', 'الاختصار مطلوب');
        if (S.uoms.some((x) => x.id !== (u && u.id) && (x.name === name || x.abbr.toLowerCase() === abbr.toLowerCase()))) return markInvalid(el, 'name', 'الاسم أو الاختصار مستخدم');
        let factor = null;
        if (TYPE_BASE[type]) {
          factor = cur.builtin ? cur.factor : Number(String(d.factor).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
          if (!(Number.isFinite(factor) && factor > 0)) return markInvalid(el, 'factor', 'المعامل يجب أن يكون رقمًا موجبًا');
        }
        const dec = Number(d.decimals);
        if (!Number.isInteger(dec) || dec < 0 || dec > 6) return markInvalid(el, 'decimals', 'من 0 إلى 6');
        close();
        commit((st) => {
          if (isNew) {
            st.uoms.push({ id: uid('uom'), name, abbr, type, factor, decimals: dec, active: d.active, builtin: false });
            audit('وحدة قياس', `إضافة «${name}» (${UOM_TYPE_LABEL[type]})`);
          } else {
            const x = st.uoms.find((y) => y.id === u.id);
            const oldF = x.factor;
            Object.assign(x, { name, abbr, factor, decimals: dec, active: d.active });
            audit('وحدة قياس', `تعديل «${name}»${oldF !== factor ? ` — المعامل ${oldF} ← ${factor}` : ''}${u.active !== d.active ? ` — ${d.active ? 'تفعيل' : 'تعطيل'}` : ''}`);
          }
          setUoms(st.uoms);
        });
        toast('تم حفظ الوحدة', 'ok');
      });
    },
  });
}

function openItemUnits(item) {
  if (!can('inventory.adjust')) return toast('غير مصرّح', 'err');
  const num = (v) => Number(String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
  const rows = Object.entries(item.convs || {}).map(([unit, c]) => ({ unit, qty: String(c.qty), of: c.of }));
  const uopt = (list, sel) => list.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)} (${esc(u.abbr)})</option>`).join('');
  openModal({
    title: `وحدات وتحويلات: ${esc(item.name)}`, size: 'lg',
    body: `<div class="hint mb-8">الوحدة الأساسية للخامة: <b>${BASE_UNIT_LABEL[item.baseUnit]}</b> — الأرصدة والتكلفة تُحسب بها. لا تحويل بين الوزن والحجم دون كثافة.</div>
      <div class="form-grid">${field('وحدة الشراء', '<select class="select" name="purchaseUnit"></select>')}${field('وحدة التخزين (للعرض)', '<select class="select" name="storageUnit"></select>')}${field('وحدة الاستخدام في الوصفة', '<select class="select" name="recipeUnit"></select>')}${field('الكثافة (جرام لكل 1 مللي) — اختياري', `<input class="input" name="density" inputmode="decimal" value="${item.density || ''}">`)}</div>
      <h4 class="mt-14 mb-8">تحويلات هذه الخامة: 1 وحدة تعبئة/تحضير = كمية من وحدة أخرى</h4><div id="cv"></div>
      <button class="btn btn-sm mt-8" data-addcv>${icon('plus')} إضافة تحويل</button><div class="card mt-14"><div class="card-b" id="cvp"></div></div><div class="err-t" id="cve"></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const build = () => {
        const convs = {};
        rows.forEach((r) => { convs[r.unit] = { qty: num(r.qty), of: r.of }; });
        const dn = el.querySelector('[name=density]').value.trim();
        return { baseUnit: item.baseUnit, density: dn === '' ? 0 : num(dn), convs };
      };
      const draw = () => {
        el.querySelector('#cv').innerHTML = rows.map((r, i) => `<div class="pay-row" style="grid-template-columns:1.1fr 90px 1.1fr 34px" data-i="${i}"><select class="select" data-f="unit">${uopt(Object.values(UOM).filter((u) => !TYPE_BASE[u.type] && (u.active || u.id === r.unit)), r.unit)}</select><input class="input" data-f="qty" inputmode="decimal" value="${esc(r.qty)}"><select class="select" data-f="of">${uopt(Object.values(UOM).filter((u) => u.active || u.id === r.of), r.of)}</select><button class="btn btn-ghost btn-icon btn-sm" data-rm style="color:var(--red)">${icon('trash')}</button></div>`).join('') || '<div class="muted">لا توجد تحويلات</div>';
      };
      const fill = (t) => ['purchase', 'storage', 'recipe'].forEach((k) => {
        const sel = el.querySelector(`[name=${k}Unit]`);
        const cur = sel.dataset.init === '1' ? sel.value : (item[`${k}Unit`] || '');
        sel.dataset.init = '1';
        sel.innerHTML = `<option value="">الافتراضي</option>${uopt(compatibleUnits(t, cur).map((id) => UOM[id]), cur)}`;
      });
      const check = () => {
        const t = build();
        let err = '';
        if (!Number.isFinite(t.density) || t.density < 0) err = 'الكثافة غير صحيحة';
        if (!err && new Set(rows.map((r) => r.unit)).size !== rows.length) err = 'وحدة مكررة في التحويلات';
        if (!err) err = validateConvs(t);
        el.querySelector('#cve').textContent = err;
        el.querySelector('#cvp').innerHTML = err ? '' : (rows.map((r) => `<div class="kv"><span>1 ${esc(UOM[r.unit].name)}</span><b class="num">${fmtQty(toBase(1, r.unit, t))} ${BASE_UNIT_LABEL[item.baseUnit]}</b></div>`).join('') || '<div class="muted">لا توجد تحويلات</div>');
        if (!err) fill(t);
        return err ? null : t;
      };
      draw(); fill(build()); check();
      el.querySelector('[data-addcv]').addEventListener('click', () => {
        const free = Object.values(UOM).find((u) => !TYPE_BASE[u.type] && u.active && !rows.some((r) => r.unit === u.id));
        if (!free) return toast('كل وحدات التعبئة/التحضير مضافة بالفعل', 'warn');
        rows.push({ unit: free.id, qty: '1', of: item.baseUnit }); draw(); check();
      });
      el.querySelector('#cv').addEventListener('change', (e) => { const r = e.target.closest('[data-i]'); if (!r) return; rows[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; check(); });
      el.querySelector('#cv').addEventListener('input', (e) => { const r = e.target.closest('[data-i]'); if (r && e.target.dataset.f === 'qty') { rows[Number(r.dataset.i)].qty = e.target.value; check(); } });
      el.querySelector('#cv').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { rows.splice(Number(b.closest('[data-i]').dataset.i), 1); draw(); check(); } });
      el.querySelector('[name=density]').addEventListener('input', check);
      el.querySelector('[data-ok]').addEventListener('click', () => {
        const t = check();
        if (!t) return;
        const pick = (k) => el.querySelector(`[name=${k}Unit]`).value;
        close();
        commit((st) => {
          const x = st.inventory.find((y) => y.id === item.id);
          if (JSON.stringify(x.convs || {}) !== JSON.stringify(t.convs) || (x.density || 0) !== t.density) {
            (x.convHistory = x.convHistory || []).push({ at: new Date().toISOString(), by: (currentUser() || {}).name || '', convs: clone(x.convs || {}), density: x.density || 0 });
            audit('تغيير تحويلات خامة', `${x.name}: ${Object.entries(t.convs).map(([id, c]) => `${UOM[id].name}=${c.qty} ${UOM[c.of].name}`).join('، ') || 'بدون'}${t.density ? ` — كثافة ${t.density}` : ''}`);
          }
          x.convs = t.convs; x.density = t.density;
          x.purchaseUnit = pick('purchase'); x.storageUnit = pick('storage'); x.recipeUnit = pick('recipe');
        });
        toast('تم حفظ وحدات الخامة', 'ok');
      });
    },
  });
}

function openReceiveProduct() {
  const list = S.products.filter((p) => p.active && p.stockMode === 'direct');
  if (!list.length) return toast('لا توجد أصناف بمخزون مباشر. فعّل «مخزون مباشر» في الصنف أولًا', 'warn');
  openModal({
    title: 'استلام بضاعة (سوبر ماركت)', size: 'sm',
    body: `<div class="col">${field('الصنف', `<select class="select" name="p">${list.map((x) => `<option value="${x.id}">${esc(x.name)} — ${stockLabelDirect(x)}</option>`).join('')}</select>`)}${field('الكمية المستلمة <span id="ul"></span>', '<input class="input" name="q" inputmode="decimal">')}${field('سعر الشراء الجديد (ج.م) — اختياري', '<input class="input" name="c" inputmode="decimal" placeholder="يُحسب متوسط مرجّح مع الرصيد">')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>تسجيل الاستلام</button>',
    onMount(el, close) {
      const sel = el.querySelector('[name=p]');
      const lab = () => { el.querySelector('#ul').textContent = isWeight(S.products.find((x) => x.id === sel.value)) ? '(كجم)' : '(قطعة)'; };
      sel.addEventListener('change', lab); lab();
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const q = Number(String(d.q).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
        if (!(q > 0)) return markInvalid(el, 'q', 'أدخل كمية صحيحة');
        let c = null;
        if (d.c.trim()) { c = parseEgp(d.c); if (Number.isNaN(c) || c < 0) return markInvalid(el, 'c', 'سعر غير صحيح'); }
        const pr = S.products.find((x) => x.id === d.p);
        close();
        commit((st) => {
          const x = st.products.find((y) => y.id === pr.id);
          const wt = isWeight(x);
          const oldU = (x.stockQty || 0) / (wt ? 1000 : 1);
          if (c != null) x.costPrice = oldU > 0 ? Math.round((oldU * (x.costPrice || 0) + q * c) / (oldU + q)) : c;
          x.stockQty = (x.stockQty || 0) + Math.round(wt ? q * 1000 : q);
          audit('استلام بضاعة', `${x.name} +${fmtQty(q)} ${wt ? 'كجم' : 'قطعة'}`);
        });
        toast('تم تسجيل الاستلام', 'ok');
      });
    },
  });
}

function openProductForm(p) {
  const isNew = !p;
  const cur = p || { name: '', categoryId: S.categories[0].id, sku: '', price: 0, emoji: '🍽️', tone: 0, stockMode: 'none', active: true, taxExempt: false, modifierGroupIds: [], extraCost: 0, image: '' };
  let image = cur.image || '';
  openModal({
    title: isNew ? 'إضافة صنف' : `تعديل: ${esc(cur.name)}`, size: 'lg',
    body: `<div class="form-grid">
      ${field('اسم الصنف (عربي) *', `<input class="input" name="name" value="${esc(cur.name)}">`)}
      ${field('التصنيف *', `<select class="select" name="categoryId">${options(S.categories, cur.categoryId)}</select>`)}
      ${field('SKU *', `<input class="input" name="sku" value="${esc(cur.sku)}" placeholder="HOP-0000">`)}
      ${field('سعر البيع (ج.م) *', `<input class="input" name="price" inputmode="decimal" value="${cur.price ? egpToInput(cur.price) : ''}">`)}
      ${field('تكلفة إضافية مباشرة (ج.م) — تغليف…', `<input class="input" name="extraCost" inputmode="decimal" value="${egpToInput(cur.extraCost || 0)}">`)}
      ${field('رمز تعبيري (بدل الصورة)', `<input class="input" name="emoji" value="${esc(cur.emoji)}" maxlength="4">`)}
      ${field('تتبع المخزون', `<select class="select" name="stockMode"><option value="none" ${cur.stockMode === 'none' ? 'selected' : ''}>بدون تتبع</option><option value="recipe" ${cur.stockMode === 'recipe' ? 'selected' : ''}>حسب الوصفة</option><option value="direct" ${cur.stockMode === 'direct' ? 'selected' : ''}>مخزون مباشر (سوبر ماركت)</option></select>`)}
      ${field('نوع البيع (وزن = السعر لكل كجم)', `<select class="select" name="unitType"><option value="piece" ${cur.unitType !== 'weight' ? 'selected' : ''}>بالقطعة</option><option value="weight" ${cur.unitType === 'weight' ? 'selected' : ''}>بالوزن (كجم)</option></select>`)}
      ${field('سعر الشراء/التكلفة (ج.م لكل قطعة أو كجم)', `<input class="input" name="costPrice" inputmode="decimal" value="${cur.costPrice ? egpToInput(cur.costPrice) : ''}">`)}
      ${field('الكمية الحالية (قطعة أو كجم) — للمخزون المباشر', `<input class="input" name="stockQty" inputmode="decimal" value="${cur.stockQty ? (cur.unitType === 'weight' ? cur.stockQty / 1000 : cur.stockQty) : ''}">`)}
      ${field('حد إعادة الطلب (قطعة أو كجم)', `<input class="input" name="minQty" inputmode="decimal" value="${cur.minQty ? (cur.unitType === 'weight' ? cur.minQty / 1000 : cur.minQty) : ''}">`)}
      <div class="field full"><label>الصورة (معاينة محلية — تُحفظ في المتصفح فقط)</label><div class="row"><div class="thumb tone-${cur.tone}" id="img-prev" style="width:60px;height:60px;border-radius:12px;display:grid;place-items:center;font-size:30px;background-size:cover;background-position:center;${image ? `background-image:url('${esc(image)}')` : ''}">${image ? '' : esc(cur.emoji)}</div><input type="file" accept="image/*" name="file"><button type="button" class="btn btn-sm" data-rmimg>إزالة الصورة</button></div></div>
      <div class="field full"><label>خيارات التخصيص المرتبطة بالصنف</label><div class="chips">${S.modifierGroups.map((g) => `<label class="chip check"><input type="checkbox" data-mg="${g.id}" ${cur.modifierGroupIds.includes(g.id) ? 'checked' : ''}> ${esc(g.name)} (${esc(g.options.slice(0, 2).map((o) => o.name).join('/'))}…)</label>`).join('')}</div></div>
      <label class="check"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> نشط</label>
      <label class="check"><input type="checkbox" name="taxExempt" ${cur.taxExempt ? 'checked' : ''}> معفى من الضريبة</label>
    </div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[name=file]').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        compressImage(f, (url) => { image = url; const pv = el.querySelector('#img-prev'); pv.style.backgroundImage = `url('${url}')`; pv.textContent = ''; });
      });
      el.querySelector('[data-rmimg]').addEventListener('click', () => { image = ''; const pv = el.querySelector('#img-prev'); pv.style.backgroundImage = ''; pv.textContent = el.querySelector('[name=emoji]').value; });
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        let bad = false;
        const name = d.name.trim();
        const price = parseEgp(d.price);
        const extra = d.extraCost.trim() === '' ? 0 : parseEgp(d.extraCost);
        if (!name) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (!d.sku.trim()) { markInvalid(el, 'sku', 'SKU مطلوب'); bad = true; }
        else if (S.products.some((x) => x.sku.toLowerCase() === d.sku.trim().toLowerCase() && x.id !== (p && p.id))) { markInvalid(el, 'sku', 'SKU مستخدم لصنف آخر'); bad = true; }
        if (Number.isNaN(price) || price <= 0) { markInvalid(el, 'price', 'أدخل سعرًا صحيحًا أكبر من صفر'); bad = true; }
        if (Number.isNaN(extra)) { markInvalid(el, 'extraCost', 'قيمة غير صحيحة'); bad = true; }
        if (bad) return;
        const num2 = (v) => Number(String(v || '0').replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
        const cost = (d.costPrice || '').trim() === '' ? 0 : parseEgp(d.costPrice);
        const stk = num2(d.stockQty); const mn = num2(d.minQty);
        if (Number.isNaN(cost) || cost < 0 || !(stk >= 0) || !(mn >= 0)) return toast('تحقق من سعر الشراء والكمية وحد إعادة الطلب', 'err');
        const wt = d.unitType === 'weight';
        const directFields = { unitType: d.unitType || 'piece', costPrice: cost, stockQty: Math.round(wt ? stk * 1000 : stk), minQty: Math.round(wt ? mn * 1000 : mn) };
        const groups = [...el.querySelectorAll('[data-mg]')].filter((c) => c.checked).map((c) => c.dataset.mg);
        const next = { name, categoryId: d.categoryId, sku: d.sku.trim(), price, extraCost: extra, emoji: d.emoji || '🍽️', stockMode: d.stockMode, active: d.active, taxExempt: d.taxExempt, modifierGroupIds: groups, image, ...directFields };
        close();
        commit((s) => {
          if (isNew) s.products.push({ id: uid('p'), tone: s.products.length % 8, ...next });
          else Object.assign(s.products.find((x) => x.id === p.id), next);
        });
        toast(isNew ? 'تمت إضافة الصنف' : 'تم حفظ التعديلات', 'ok');
      });
    },
  });
}

// ===== التصنيفات =====
PAGES.categories = {
  render() {
    const edit = can('catalog.edit');
    const cats = S.categories.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    return `${pageHead('إدارة التصنيفات', `<button class="btn btn-primary" data-add ${edit ? '' : 'disabled'}>${icon('plus')} إضافة تصنيف</button>`)}
      ${demoNote('ترتيب التصنيفات وحالتها يتحدثان فورًا في شريط التصنيفات بشاشة الكاشير.')}
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الترتيب</th><th>الأيقونة</th><th>الاسم</th><th>عدد الأصناف</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${cats.map((c, i) => `<tr data-id="${c.id}"><td><div class="row"><button class="btn btn-sm btn-icon" data-mv="-1" ${i === 0 || !edit ? 'disabled' : ''}>${icon('up')}</button><button class="btn btn-sm btn-icon" data-mv="1" ${i === cats.length - 1 || !edit ? 'disabled' : ''}>${icon('down')}</button><span class="num">${fmtInt(i + 1)}</span></div></td>
        <td style="font-size:24px">${c.icon}</td><td><b>${esc(c.name)}</b></td><td class="num">${fmtInt(S.products.filter((p) => p.categoryId === c.id).length)}</td>
        <td>${c.active ? badge('نشط', 'green') : badge('غير نشط', 'gray')}</td>
        <td><div class="actions"><button class="btn btn-sm" data-edit ${edit ? '' : 'disabled'}>${icon('edit')} تعديل</button><button class="btn btn-sm" data-toggle ${edit ? '' : 'disabled'}>${c.active ? 'تعطيل' : 'تفعيل'}</button></div></td></tr>`).join('')}
      </tbody></table></div></div>`;
  },
  bind(root) {
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', () => openCategoryForm(null));
    root.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll('[data-mv]').forEach((b) => b.addEventListener('click', () => commit((s) => {
        const list = s.categories.slice().sort((a, b2) => a.sortOrder - b2.sortOrder);
        const i = list.findIndex((c) => c.id === id);
        const j = i + Number(b.dataset.mv);
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        list.forEach((c, k) => { s.categories.find((x) => x.id === c.id).sortOrder = k + 1; });
      })));
      tr.querySelector('[data-edit]').addEventListener('click', () => openCategoryForm(S.categories.find((c) => c.id === id)));
      tr.querySelector('[data-toggle]').addEventListener('click', () => commit((s) => { const c = s.categories.find((x) => x.id === id); c.active = !c.active; }));
    });
  },
};

function openCategoryForm(c) {
  const isNew = !c;
  const cur = c || { name: '', icon: '🍽️', active: true };
  openModal({
    title: isNew ? 'إضافة تصنيف' : 'تعديل التصنيف', size: 'sm',
    body: `<div class="col">${field('اسم التصنيف *', `<input class="input" name="name" value="${esc(cur.name)}">`)}${field('الأيقونة (رمز تعبيري)', `<input class="input" name="icon" value="${esc(cur.icon)}" maxlength="4">`)}<label class="check"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> نشط</label></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        if (!d.name.trim()) return markInvalid(el, 'name', 'الاسم مطلوب');
        if (S.categories.some((x) => x.name === d.name.trim() && x.id !== (c && c.id))) return markInvalid(el, 'name', 'الاسم مستخدم');
        close();
        commit((s) => {
          if (isNew) s.categories.push({ id: uid('c'), name: d.name.trim(), icon: d.icon || '🍽️', active: d.active, sortOrder: s.categories.length + 1 });
          else Object.assign(s.categories.find((x) => x.id === c.id), { name: d.name.trim(), icon: d.icon || '🍽️', active: d.active });
        });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

// ===== 72-backoffice.js =====
// ---------------------------------------------------------------------------
// الوصفات والتكلفة — المخزون — المشتريات — الموردون — المصروفات — العملاء
// ---------------------------------------------------------------------------
const COSTING_NOTE = 'حسابات تكلفة تجريبية: تعتمد على أسعار المكونات الحالية في بيانات العرض ولا تمثل دفتر مخزون حقيقي.';

function unitOptions(item, selected) {
  return compatibleUnits(item, selected).map((u) => `<option value="${u}" ${u === selected ? 'selected' : ''}>${esc(UOM[u].name)} (${esc(UOM[u].abbr)})</option>`).join('');
}
function defUnit(it, kind) { const u = it[`${kind}Unit`]; return u && UOM[u] ? u : displayUnitFor(it.baseUnit); }
function storageLabel(i, q) {
  const su = i.storageUnit && UOM[i.storageUnit];
  if (!su) return '';
  try { return `${fmtQty(q / toBase(1, i.storageUnit, i))} ${su.name}`; } catch (e) { return ''; }
}
function movQty(m, i) {
  const b = `${m.delta > 0 ? '+' : ''}${fmtQty(m.delta)} ${i ? BASE_UNIT_LABEL[i.baseUnit] : ''}`;
  return m.orig && UOM[m.orig.unit] ? `${b} <span class="muted xs">(${fmtQty(m.orig.qty)} ${esc(UOM[m.orig.unit].name)})</span>` : b;
}
function displayUnitFor(base) { return base === 'g' ? 'kg' : base === 'ml' ? 'liter' : 'piece'; }
/** سعر الوحدة المعروضة (لكل كجم / لتر / قطعة) بالقروش */
function costPerDisplay(i) { return Math.round(i.costPerBase * UNITS[displayUnitFor(i.baseUnit)].factor); }
function qtyLabel(i) {
  { const sl = storageLabel(i, i.qty); if (sl) return sl; }
  if (i.baseUnit === 'piece') return `${fmtQty(i.qty)} قطعة`;
  const big = Math.abs(i.qty) >= 1000;
  return big ? `${fmtQty(i.qty / 1000)} ${i.baseUnit === 'g' ? 'كجم' : 'لتر'}` : `${fmtQty(i.qty)} ${BASE_UNIT_LABEL[i.baseUnit]}`;
}
function minLabel(i) {
  { const sl = storageLabel(i, i.minQty); if (sl) return sl; }
  if (i.baseUnit === 'piece') return `${fmtQty(i.minQty)} قطعة`;
  return i.minQty >= 1000 ? `${fmtQty(i.minQty / 1000)} ${i.baseUnit === 'g' ? 'كجم' : 'لتر'}` : `${fmtQty(i.minQty)} ${BASE_UNIT_LABEL[i.baseUnit]}`;
}

// ===== الوصفات والتكلفة =====
const fmtUnitCost = (p) => (p < 100 ? `${(p / 100).toFixed(4)} ج.م` : fmtMoney(Math.round(p)));
function recipeCalc(p) {
  const lines = (S.recipes[p.id] || []).flatMap((l) => {
    const inv = invById(l.inventoryId);
    return inv ? [{ qty: l.qty, unit: l.unit, costPerBase: inv.costPerBase, base: inv.baseUnit, inv, line: l }] : [];
  });
  const rc = recipeCost(lines);
  const m = recipeMargin({ price: p.price, taxExempt: p.taxExempt, ingredientCost: rc.cost, extraCost: p.extraCost }, taxConfigOf(S.settings));
  return { lines: rc.lines.map((l, i) => ({ ...l, inv: lines[i].inv })), ingredientCost: rc.cost, ...m };
}

PAGES.recipes = {
  render() {
    const list = S.products.filter((p) => (S.recipes[p.id] || []).length || p.stockMode === 'recipe');
    if (!UI.recipes.selected || !list.some((p) => p.id === UI.recipes.selected)) UI.recipes.selected = list[0] ? list[0].id : null;
    const sel = S.products.find((p) => p.id === UI.recipes.selected);
    const rc = sel ? recipeCalc(sel) : null;
    const edit = can('catalog.edit');
    return `${pageHead('الوصفات وتكلفة المنتجات')}${demoNote(COSTING_NOTE)}
      <div class="grid" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
        <div class="card"><div class="card-h">المنتجات (${fmtInt(list.length)})</div><div style="max-height:62vh;overflow:auto">
          ${list.map((p) => { const c = recipeCalc(p); return `<button class="btn btn-block" data-sel="${p.id}" style="justify-content:space-between;border-radius:0;border-width:0 0 1px 0;height:52px;${p.id === UI.recipes.selected ? 'background:var(--primary-l)' : ''}"><span>${p.emoji} ${esc(p.name)}</span><span class="num sm ${c.marginPct < 50 ? 'neg-num' : 'pos-num'}">${fmtPct(c.marginPct)}</span></button>`; }).join('')}</div></div>
        <div class="card">${sel ? `<div class="card-b">
          <div class="recipe-hero mb-14"><div class="pic tone-${sel.tone}" ${thumbStyle(sel)}>${sel.image ? '' : sel.emoji}</div>
            <div class="grow"><h3 style="font-size:20px">${esc(sel.name)}</h3><div class="muted">${esc(categoryName(sel.categoryId))}</div></div>
            <div class="mini-stat"><div class="v num">${fmtMoney(sel.price)}</div><div class="l">سعر البيع</div></div>
            <div class="mini-stat"><div class="v num">${fmtMoney(rc.cost)}</div><div class="l">تكلفة الوصفة</div></div>
            <div class="mini-stat"><div class="v num pos-num">${fmtMoney(rc.profit)}</div><div class="l">الربح الإجمالي التقديري</div></div>
            <div class="mini-stat"><div class="v num">${fmtPct(rc.marginPct)}</div><div class="l">هامش الربح</div></div></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>المكوّن</th><th>الكمية للحصة</th><th>الوحدة</th><th>سعر الوحدة الحالي</th><th>التكلفة</th></tr></thead><tbody>
            ${rc.lines.map((l) => `<tr><td><b>${esc(l.inv.name)}</b></td><td class="num">${fmtQty(l.qty)}</td><td>${UNITS[l.unit].label}</td><td class="num">${fmtUnitCost(l.inv.costPerBase * toBase(1, l.unit, l.inv))} / ${UNITS[l.unit].label}</td><td class="num">${fmtMoney(l.subtotal)}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('لا توجد وصفة لهذا المنتج بعد', '🧪')}</td></tr>`}
          </tbody><tfoot><tr><td colspan="4" class="bold">تكلفة المكونات</td><td class="num bold">${fmtMoney(rc.ingredientCost)}</td></tr>
            <tr><td colspan="4">تكلفة مباشرة إضافية (تغليف…)</td><td class="num">${fmtMoney(sel.extraCost)}</td></tr>
            <tr><td colspan="4">سعر البيع بدون ضريبة${S.settings.tax.enabled && !sel.taxExempt && S.settings.tax.mode === 'inclusive' ? ' (السعر شامل الضريبة)' : ''}</td><td class="num">${fmtMoney(rc.netPrice)}</td></tr></tfoot></table></div>
          <div class="hint mt-8">المعادلات: تكلفة الوصفة = Σ (كمية × تكلفة الوحدة) + التكلفة الإضافية. الربح = سعر البيع بدون ضريبة − التكلفة. الهامش = الربح ÷ سعر البيع بدون ضريبة × 100. لا تشمل الخصومات. الفواتير المكتملة تحتفظ بتكلفتها وقت البيع ولا تتغير.</div>
          <div class="row mt-14"><button class="btn btn-primary" data-edit-recipe ${edit ? '' : 'disabled'}>${icon('edit')} تعديل الوصفة</button></div>
        </div>` : emptyState('اختر منتجًا')}</div>
      </div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => { UI.recipes.selected = b.dataset.sel; render(); }));
    const e = root.querySelector('[data-edit-recipe]');
    if (e) e.addEventListener('click', () => openRecipeEditor(S.products.find((p) => p.id === UI.recipes.selected)));
  },
};

function openRecipeEditor(p) {
  let rows = clone(S.recipes[p.id] || []);
  const draw = (el) => {
    el.querySelector('#rows').innerHTML = rows.map((r, i) => {
      const inv = invById(r.inventoryId) || S.inventory[0];
      return `<div class="pay-row" style="grid-template-columns:1.4fr 90px 110px 34px" data-i="${i}">
        <select class="select" data-f="inv">${options(S.inventory.filter((x) => x.active), r.inventoryId)}</select>
        <input class="input" data-f="qty" inputmode="decimal" value="${r.qty}">
        <select class="select" data-f="unit">${unitOptions(inv, r.unit)}</select>
        <button class="btn btn-ghost btn-icon btn-sm" data-rm title="حذف" style="color:var(--red)">${icon('trash')}</button></div>`;
    }).join('') || '<div class="muted">لا توجد مكونات — أضف مكونًا.</div>';
  };
  openModal({
    title: `وصفة: ${esc(p.name)}`, size: 'lg',
    body: `<div class="hint mb-8">الكمية لكل حصة واحدة. تُخصم المكونات من المخزون عند إتمام البيع فقط (محاكاة).</div><div class="row mb-8"><select class="select" id="copyfrom" style="max-width:240px"><option value="">انسخ وصفة من منتج...</option>${S.products.filter((x) => x.id !== p.id && (S.recipes[x.id] || []).length).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><button class="btn btn-sm" data-copy>نسخ</button></div><div id="rows"></div>
      <button class="btn btn-sm mt-8" data-addrow>${icon('plus')} إضافة مكوّن</button>
      <div class="mt-14">${field('تكلفة مباشرة إضافية للحصة (ج.م)', `<input class="input" name="extra" inputmode="decimal" value="${egpToInput(p.extraCost || 0)}">`)}</div>
      <div class="card mt-14"><div class="card-b" id="live"></div></div><div class="err-t" id="err"></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ الوصفة</button>',
    onMount(el, close) {
      const live = () => {
        try {
          const lines = rows.map((r) => { const inv = invById(r.inventoryId); return { qty: Number(r.qty) || 0, unit: r.unit, costPerBase: inv.costPerBase, base: inv.baseUnit }; });
          const c = recipeCost(lines).cost;
          const extra = parseEgp(el.querySelector('[name=extra]').value || '0');
          const m = recipeMargin({ price: p.price, taxExempt: p.taxExempt, ingredientCost: c, extraCost: Number.isNaN(extra) ? 0 : extra }, taxConfigOf(S.settings));
          el.querySelector('#live').innerHTML = `<div class="kv"><span>تكلفة المكونات</span><b class="num">${fmtMoney(c)}</b></div><div class="kv"><span>الربح التقديري / الهامش</span><b class="num">${fmtMoney(m.profit)} — ${fmtPct(m.marginPct)}</b></div>`;
          el.querySelector('#err').textContent = '';
        } catch (e) { el.querySelector('#err').textContent = e.message; }
      };
      draw(el); live();
      el.querySelector('[data-copy]').addEventListener('click', () => { const src = el.querySelector('#copyfrom').value; if (!src) return; rows = clone(S.recipes[src] || []); draw(el); live(); });
      el.querySelector('[data-addrow]').addEventListener('click', () => { const inv = S.inventory.find((x) => x.active); rows.push({ inventoryId: inv.id, qty: 1, unit: defUnit(inv, 'recipe') }); draw(el); live(); });
      el.querySelector('#rows').addEventListener('change', (e) => {
        const row = e.target.closest('[data-i]'); if (!row) return;
        const r = rows[Number(row.dataset.i)];
        const f = e.target.dataset.f;
        if (f === 'inv') { r.inventoryId = e.target.value; r.unit = defUnit(invById(r.inventoryId), 'recipe'); draw(el); }
        if (f === 'unit') r.unit = e.target.value;
        live();
      });
      el.querySelector('#rows').addEventListener('input', (e) => { const row = e.target.closest('[data-i]'); if (row && e.target.dataset.f === 'qty') { rows[Number(row.dataset.i)].qty = e.target.value; live(); } });
      el.querySelector('#rows').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { rows.splice(Number(b.closest('[data-i]').dataset.i), 1); draw(el); live(); } });
      el.querySelector('[name=extra]').addEventListener('input', live);
      el.querySelector('[data-ok]').addEventListener('click', () => {
        const extra = parseEgp(el.querySelector('[name=extra]').value || '0');
        if (Number.isNaN(extra)) return toast('التكلفة الإضافية غير صحيحة', 'err');
        const cleaned = [];
        for (const r of rows) {
          const q = Number(String(r.qty).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
          if (!(q > 0)) return toast('كل الكميات يجب أن تكون أكبر من صفر', 'err');
          if (!decimalsOk(q, r.unit)) return toast(`عدد المنازل العشرية غير مسموح للوحدة ${UOM[r.unit].name}`, 'err');
          cleaned.push({ inventoryId: r.inventoryId, qty: q, unit: r.unit });
        }
        if (new Set(cleaned.map((r) => r.inventoryId)).size !== cleaned.length) return toast('مكوّن مكرر — ادمج الكميات في سطر واحد', 'err');
        close();
        commit((s) => { s.recipes[p.id] = cleaned; const x = s.products.find((y) => y.id === p.id); x.extraCost = extra; if (cleaned.length) x.stockMode = 'recipe'; });
        toast('تم حفظ الوصفة', 'ok');
      });
    },
  });
}

// ===== المخزون =====
PAGES.inventory = {
  render() {
    const id = 'inventory';
    tableStates[id] = tableStates[id] || { q: '', sort: null, dir: 1, page: 1, f: {} };
    const f = tableStates[id].f || (tableStates[id].f = {});
    let rows = S.inventory.slice();
    if (f.status) rows = rows.filter((i) => (f.status === 'low' ? stockStatus(i) !== 'ok' : stockStatus(i) === 'ok'));
    const value = sum(S.inventory, (i) => Math.round(Math.max(0, i.qty) * i.costPerBase));
    const low = lowStockItems(S).length;
    const adj = can('inventory.adjust');
    const recent = S.movements.slice(0, 12);
    return `${pageHead('إدارة المخزون', `<button class="btn btn-primary" data-add ${adj ? '' : 'disabled'}>${icon('plus')} إضافة صنف مخزون</button><button class="btn" data-receive ${adj ? '' : 'disabled'}>${icon('download')} استلام بضاعة</button>`)}
      ${demoNote('حركات المخزون هنا محاكاة داخل المتصفح ولا تمثل دفتر مخزون إنتاجي.')}
      <div class="stats">${statCard('إجمالي أصناف المخزون', fmtInt(S.inventory.length), 'blue', 'inventory')}${statCard('أصناف منخفضة', fmtInt(low), low ? 'red' : 'gray', 'alert')}${statCard('قيمة المخزون التقديرية', fmtMoney(value), 'green', 'money')}${statCard('آخر الحركات', fmtInt(S.movements.length), 'amber', 'chart', 'إجمالي السجلات')}</div>
      ${dataTable({
        id, rows, pageSize: 10, empty: 'لا توجد أصناف مخزون', search: (i) => i.name,
        filtersHtml: tblSelectFilter(id, 'status', 'كل الحالات', [['low', 'منخفض / نافد'], ['ok', 'طبيعي']]),
        rowClass: (i) => (stockStatus(i) !== 'ok' ? 'row-low' : ''),
        columns: [
          { label: 'الصنف', render: (i) => `<b>${esc(i.name)}</b>`, sort: (i) => i.name },
          { label: 'الكمية الحالية', render: (i) => `<span class="num">${qtyLabel(i)}</span>`, sort: (i) => i.qty },
          { label: 'الحد الأدنى', render: (i) => `<span class="num">${minLabel(i)}</span>` },
          { label: 'سعر الوحدة', render: (i) => `<span class="num">${fmtMoney(costPerDisplay(i))}</span> / ${UNITS[displayUnitFor(i.baseUnit)].label}` },
          { label: 'قيمة المخزون', render: (i) => `<span class="num">${fmtMoney(Math.round(Math.max(0, i.qty) * i.costPerBase))}</span>`, sort: (i) => i.qty * i.costPerBase },
          { label: 'الحالة', render: (i) => { const s = stockStatus(i); return s === 'out' ? badge('نفد', 'red') : s === 'low' ? badge('منخفض', 'amber') : badge('طبيعي', 'green'); } },
          { label: '', render: () => `<div class="actions"><button class="btn btn-sm" data-act="adjust" ${adj ? '' : 'disabled'}>تسوية</button><button class="btn btn-sm" data-act="waste" ${adj ? '' : 'disabled'}>إضافة / هدر</button><button class="btn btn-sm" data-act="edit" ${adj ? '' : 'disabled'}>${icon('edit')}</button><button class="btn btn-sm" data-act="uom" ${adj ? '' : 'disabled'}>الوحدات</button><button class="btn btn-sm" data-act="hist">السجل</button></div>` },
        ],
      })}
      <div class="card mt-14"><div class="card-h">آخر حركات المخزون</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>الصنف</th><th>النوع</th><th>الكمية</th><th>السبب</th></tr></thead><tbody>
        ${recent.map((m) => { const i = invById(m.inventoryId); return `<tr><td>${dt(m.at)}</td><td>${esc(i ? i.name : '—')}</td><td>${badge(MOVE_LABEL[m.type] || m.type, m.delta < 0 ? 'red' : 'green')}</td><td class="num ${m.delta < 0 ? 'neg-num' : 'pos-num'}">${movQty(m, i)}</td><td>${esc(m.reason)}</td></tr>`; }).join('') || `<tr><td colspan="5">${emptyState('لا توجد حركات')}</td></tr>`}
      </tbody></table></div></div>`;
  },
  bind(root) {
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', () => openInventoryForm(null));
    const rc = root.querySelector('[data-receive]');
    if (rc) rc.addEventListener('click', () => openReceiveDialog(null));
    bindTable(root, 'inventory', (act, i) => {
      if (act === 'edit') openInventoryForm(i);
      if (act === 'adjust') openAdjustDialog(i, 'adjust');
      if (act === 'waste') openAdjustDialog(i, 'waste');
      if (act === 'hist') openHistory(i);
      if (act === 'uom') openItemUnits(i);
    });
    bindFilters(root);
  },
};

function openInventoryForm(i) {
  const isNew = !i;
  const cur = i || { name: '', baseUnit: 'g', qty: 0, minQty: S.settings.inventory.defaultMinQty, costPerBase: 0 };
  const du = (b) => UNITS[displayUnitFor(b)];
  openModal({
    title: isNew ? 'إضافة صنف مخزون' : `تعديل: ${esc(cur.name)}`, size: 'sm',
    body: `<div class="col">${field('الاسم *', `<input class="input" name="name" value="${esc(cur.name)}">`)}
      ${field('وحدة القياس الأساسية', `<select class="select" name="base" ${isNew ? '' : 'disabled'}><option value="g" ${cur.baseUnit === 'g' ? 'selected' : ''}>وزن (جرام / كجم)</option><option value="ml" ${cur.baseUnit === 'ml' ? 'selected' : ''}>حجم (مللي / لتر)</option><option value="piece" ${cur.baseUnit === 'piece' ? 'selected' : ''}>قطعة</option></select>`)}
      ${isNew ? field('الكمية الافتتاحية (بالوحدة الأساسية)', `<input class="input" name="qty" inputmode="decimal" value="0">`) : ''}
      ${field('الحد الأدنى (بالوحدة الأساسية: جرام/مللي/قطعة)', `<input class="input" name="min" inputmode="decimal" value="${cur.minQty}">`)}
      ${field(`سعر الوحدة (ج.م) لكل <span id="du">${du(cur.baseUnit).label}</span>`, `<input class="input" name="cost" inputmode="decimal" value="${egpToInput(costPerDisplay(cur))}">`)}
      <div class="hint">تغيير السعر يحدّث تكلفة الوصفات الحالية فورًا، بينما تظل الفواتير المكتملة بتكلفتها السابقة.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const baseSel = el.querySelector('[name=base]');
      baseSel.addEventListener('change', () => { el.querySelector('#du').textContent = du(baseSel.value).label; });
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const base = isNew ? d.base : cur.baseUnit;
        const num = (v) => Number(String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
        const min = num(d.min);
        const cost = parseEgp(d.cost);
        const qty = isNew ? num(d.qty) : cur.qty;
        let bad = false;
        if (!d.name.trim()) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (!(min >= 0)) { markInvalid(el, 'min', 'قيمة غير صحيحة'); bad = true; }
        if (Number.isNaN(cost) || cost < 0) { markInvalid(el, 'cost', 'سعر غير صحيح'); bad = true; }
        if (isNew && !(qty >= 0)) { markInvalid(el, 'qty', 'كمية غير صحيحة'); bad = true; }
        if (bad) return;
        const costPerBase = cost / UNITS[displayUnitFor(base)].factor;
        close();
        commit((s) => {
          if (isNew) {
            const it = { id: uid('i'), name: d.name.trim(), baseUnit: base, qty, minQty: min, costPerBase, active: true };
            s.inventory.push(it);
            if (qty) addMovement(s, it.id, 'adjust', qty, 'رصيد افتتاحي');
          } else Object.assign(s.inventory.find((x) => x.id === i.id), { name: d.name.trim(), minQty: min, costPerBase });
        });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

function openAdjustDialog(i, kind) {
  // kind === 'waste' → حركة بإشارة: (−) هدر ينقص الرصيد، (+) إضافة تزيد الرصيد. الوحدة الافتراضية = الوحدة الأساسية (مللي / جرام / قطعة)
  const signed = kind === 'waste';
  const unitSel = `<select class="select" name="unit" style="width:110px">${unitOptions(i, i.baseUnit)}</select>`;
  openModal({
    title: `${signed ? 'إضافة / هدر' : 'تسوية مخزون'} — ${esc(i.name)}`, size: 'sm',
    body: `<div class="col"><div class="kv"><span>الكمية الحالية</span><b>${qtyLabel(i)}</b></div>
      ${signed ? field('الكمية (اكتب − للهدر أو + للإضافة)', `<div class="row"><input class="input" name="qty" inputmode="text" dir="ltr" placeholder="-50  أو  +200" style="text-align:right">${unitSel}</div>`)
        : field('الكمية الفعلية بعد الجرد', `<div class="row"><input class="input" name="qty" inputmode="decimal" value="${fmtNumPlain(i.qty)}">${unitSel}</div>`)}
      ${signed ? '<div class="hint">مثال: <b dir="ltr">-50</b> مللي = هدر (ينقص من المخزون) • <b dir="ltr">+200</b> مللي = إضافة (تزيد المخزون).</div>' : ''}
      ${field(signed ? 'السبب (مطلوب عند الهدر)' : 'السبب *', `<input class="input" name="reason" placeholder="${signed ? 'مثال: انتهاء صلاحية / توريد' : 'مثال: جرد شهري'}">`)}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>تأكيد</button>',
    onMount(el, close) {
      const unitEl = el.querySelector('[name=unit]');
      if (!signed) unitEl.addEventListener('change', () => { el.querySelector('[name=qty]').value = fmtNumPlain(i.qty / toBase(1, unitEl.value, i)); });
      const norm = (v) => String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/٫/g, '.').replace(/[−–—]/g, '-').replace(/\s+/g, '');
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        let q; let sign = 0;
        if (signed) {
          const m = /^([+-])(\d*\.?\d+)$/.exec(norm(d.qty));
          if (!m) return markInvalid(el, 'qty', 'اكتب علامة − للهدر أو + للإضافة ثم الكمية، مثال: -50 أو +200');
          sign = m[1] === '-' ? -1 : 1;
          q = Number(m[2]);
          if (!(q > 0)) return markInvalid(el, 'qty', 'الكمية يجب أن تكون أكبر من صفر');
        } else {
          q = Number(norm(d.qty));
          if (!(q >= 0) || d.qty.trim() === '') return markInvalid(el, 'qty', 'أدخل كمية صحيحة');
        }
        if (!decimalsOk(q, d.unit)) return markInvalid(el, 'qty', 'عدد المنازل العشرية غير مسموح لهذه الوحدة');
        const reason = d.reason.trim() || (signed && sign > 0 ? 'إضافة يدوية' : '');
        if (!reason) return markInvalid(el, 'reason', 'السبب مطلوب');
        const base = toBase(q, d.unit, i);
        if (signed && sign < 0 && base > i.qty) return markInvalid(el, 'qty', 'الكمية الهالكة أكبر من الرصيد');
        close();
        commit((s) => {
          const it = s.inventory.find((x) => x.id === i.id);
          if (signed && sign < 0) { it.qty = Math.round((it.qty - base) * 1000) / 1000; addMovement(s, it.id, 'waste', -base, reason, '', { qty: q, unit: d.unit }); }
          else if (signed) { it.qty = Math.round((it.qty + base) * 1000) / 1000; addMovement(s, it.id, 'adjust', base, reason, '', { qty: q, unit: d.unit }); }
          else { const delta = base - it.qty; it.qty = base; addMovement(s, it.id, delta === 0 ? 'count' : 'adjust', delta, reason, '', { qty: q, unit: d.unit }); }
        });
        toast(signed ? (sign < 0 ? 'تم تسجيل الهدر' : 'تمت الإضافة للمخزون') : 'تم تسجيل الحركة', 'ok');
      });
    },
  });
}
function fmtNumPlain(n) { return String(Math.round(n * 1000) / 1000); }

function openReceiveDialog(i) {
  openModal({
    title: 'استلام بضاعة (محاكاة)', size: 'sm',
    body: `<div class="col">${field('الصنف', `<select class="select" name="inv">${options(S.inventory, i ? i.id : S.inventory[0].id)}</select>`)}
      ${field('الكمية المستلمة', `<div class="row"><input class="input" name="qty" inputmode="decimal"><select class="select" name="unit" style="width:110px"></select></div>`)}
      ${field('سعر الوحدة الجديد (ج.م) — اختياري', '<input class="input" name="price" inputmode="decimal" placeholder="اتركه فارغًا للإبقاء على السعر الحالي">')}
      ${field('ملاحظة', '<input class="input" name="reason" value="استلام يدوي">')}
      <div class="hint">عند إدخال سعر جديد تُحسب تكلفة الوحدة بالمتوسط المرجّح مع الرصيد الحالي.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>تسجيل الاستلام</button>',
    onMount(el, close) {
      const invEl = el.querySelector('[name=inv]');
      const unitEl = el.querySelector('[name=unit]');
      const fillUnits = () => { const it = invById(invEl.value); unitEl.innerHTML = unitOptions(it, defUnit(it, 'purchase')); };
      invEl.addEventListener('change', fillUnits); fillUnits();
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const q = Number(String(d.qty).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
        if (!(q > 0)) return markInvalid(el, 'qty', 'أدخل كمية صحيحة');
        if (!decimalsOk(q, d.unit)) return markInvalid(el, 'qty', 'عدد المنازل العشرية غير مسموح لهذه الوحدة');
        let price = null;
        if (d.price.trim()) { price = parseEgp(d.price); if (Number.isNaN(price) || price < 0) return markInvalid(el, 'price', 'سعر غير صحيح'); }
        const it = invById(d.inv);
        const base = toBase(q, d.unit, it);
        close();
        commit((s) => {
          const x = s.inventory.find((y) => y.id === it.id);
          if (price != null) { const nc = price / toBase(1, d.unit, it); x.costPerBase = x.qty > 0 ? (x.qty * x.costPerBase + base * nc) / (x.qty + base) : nc; }
          x.qty = Math.round((x.qty + base) * 1000) / 1000;
          addMovement(s, x.id, 'receive', base, d.reason.trim() || 'استلام', '', { qty: q, unit: d.unit });
        });
        toast('تم تسجيل الاستلام', 'ok');
      });
    },
  });
}

function openHistory(i) {
  const list = S.movements.filter((m) => m.inventoryId === i.id);
  openModal({
    title: `سجل حركة: ${esc(i.name)}`, size: 'lg',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>النوع</th><th>الكمية</th><th>السبب</th></tr></thead><tbody>
      ${list.slice(0, 60).map((m) => `<tr><td>${dt(m.at)}</td><td>${badge(MOVE_LABEL[m.type] || m.type, m.delta < 0 ? 'red' : 'green')}</td><td class="num ${m.delta < 0 ? 'neg-num' : 'pos-num'}">${movQty(m, i)}</td><td>${esc(m.reason)}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('لا توجد حركات')}</td></tr>`}
    </tbody></table></div>`,
    footer: '<button class="btn" data-close>إغلاق</button>',
  });
}

// ===== المشتريات =====
const PUR_LABEL = { draft: 'مسودة', received: 'تم الاستلام', cancelled: 'ملغية' };
const PUR_KIND = { draft: 'amber', received: 'green', cancelled: 'gray' };

PAGES.purchases = {
  render() {
    const id = 'purchases';
    tableStates[id] = tableStates[id] || { q: '', sort: 2, dir: -1, page: 1, f: {} };
    const f = tableStates[id].f || (tableStates[id].f = {});
    let rows = S.purchases.slice();
    if (f.status) rows = rows.filter((p) => p.status === f.status);
    const adj = can('inventory.adjust');
    return `${pageHead('المشتريات', `<button class="btn btn-primary" data-add ${adj ? '' : 'disabled'}>${icon('plus')} فاتورة شراء جديدة</button>`)}
      ${demoNote('لا تتم مدفوعات فعلية للموردين. المخزون يتحدث مرة واحدة فقط عند تأكيد الاستلام.')}
      ${dataTable({
        id, rows, pageSize: 10, search: (p) => `${p.no} ${supplierName(p.supplierId)}`, empty: 'لا توجد فواتير شراء',
        filtersHtml: tblSelectFilter(id, 'status', 'كل الحالات', Object.entries(PUR_LABEL)),
        columns: [
          { label: 'رقم الفاتورة', render: (p) => `<b>${esc(p.no)}</b>`, sort: (p) => p.no },
          { label: 'المورد', render: (p) => esc(supplierName(p.supplierId)) },
          { label: 'التاريخ', render: (p) => dOnly(p.date + 'T12:00:00'), sort: (p) => p.date },
          { label: 'الأصناف', render: (p) => fmtInt(p.lines.length) },
          { label: 'الإجمالي', render: (p) => `<span class="num">${fmtMoney(purchaseTotal(p))}</span>`, sort: (p) => purchaseTotal(p) },
          { label: 'المدفوع', render: (p) => `<span class="num">${fmtMoney(p.paid)}</span>` },
          { label: 'المتبقي', render: (p) => `<span class="num ${purchaseTotal(p) - p.paid > 0 && p.status !== 'cancelled' ? 'neg-num' : ''}">${fmtMoney(p.status === 'cancelled' ? 0 : purchaseTotal(p) - p.paid)}</span>` },
          { label: 'الحالة', render: (p) => badge(PUR_LABEL[p.status], PUR_KIND[p.status]) },
          { label: '', render: (p) => `<div class="actions"><button class="btn btn-sm" data-act="view">عرض</button>${p.status === 'draft' ? `<button class="btn btn-sm btn-success" data-act="receive" ${adj ? '' : 'disabled'}>تأكيد الاستلام</button><button class="btn btn-sm btn-danger" data-act="cancel" ${adj ? '' : 'disabled'}>إلغاء</button>` : ''}</div>` },
        ],
      })}`;
  },
  bind(root) {
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', openPurchaseForm);
    bindTable(root, 'purchases', (act, p) => {
      if (act === 'view') viewPurchase(p);
      if (act === 'receive') confirmDialog({ title: 'تأكيد الاستلام', message: `سيتم إضافة أصناف الفاتورة ${esc(p.no)} إلى المخزون مرة واحدة. متابعة؟`, confirmText: 'تأكيد الاستلام', onConfirm: () => { receivePurchase(p.id); } });
      if (act === 'cancel') confirmDialog({ title: 'إلغاء فاتورة الشراء', message: `إلغاء ${esc(p.no)}؟ لن يتأثر المخزون.`, confirmText: 'إلغاء الفاتورة', danger: true, onConfirm: () => commit((s) => { const x = s.purchases.find((y) => y.id === p.id); if (x.status === 'draft') x.status = 'cancelled'; }) });
    });
    bindFilters(root);
  },
};

function receivePurchase(id) {
  const p0 = S.purchases.find((x) => x.id === id);
  if (!p0 || p0.status !== 'draft') return toast('هذه الفاتورة لا يمكن استلامها (تم استلامها أو إلغاؤها)', 'err');
  commit((s) => {
    const p = s.purchases.find((x) => x.id === id);
    if (p.status !== 'draft') return; // حماية من التطبيق المزدوج
    p.status = 'received';
    p.receivedAt = new Date().toISOString();
    p.lines.forEach((l) => {
      const it = s.inventory.find((x) => x.id === l.inventoryId);
      const base = toBase(l.qty, l.unit, it);
      const nc = l.unitPrice / toBase(1, l.unit, it);
      it.costPerBase = it.qty > 0 ? (it.qty * it.costPerBase + base * nc) / (it.qty + base) : nc;
      it.qty = Math.round((it.qty + base) * 1000) / 1000;
      addMovement(s, it.id, 'receive', base, `استلام ${p.no}`, p.id, { qty: l.qty, unit: l.unit });
    });
  });
  toast('تم استلام الفاتورة وتحديث المخزون وتكلفة المكونات', 'ok');
}

function viewPurchase(p) {
  openModal({
    title: `فاتورة شراء ${esc(p.no)}`, size: 'lg',
    body: `<div class="row wrap mb-14">${badge(PUR_LABEL[p.status], PUR_KIND[p.status])}<span class="muted">${esc(supplierName(p.supplierId))} • ${dOnly(p.date + 'T12:00:00')}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead><tbody>
      ${p.lines.map((l) => { const it = invById(l.inventoryId); return `<tr><td>${esc(it ? it.name : '—')}</td><td class="num">${fmtQty(l.qty)} ${UNITS[l.unit].label}</td><td class="num">${fmtMoney(l.unitPrice)}</td><td class="num">${fmtMoney(Math.round(l.qty * l.unitPrice))}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="kv total"><span>الإجمالي</span><span class="num">${fmtMoney(purchaseTotal(p))}</span></div>
      <div class="kv"><span>المدفوع (سجل فقط)</span><span class="num">${fmtMoney(p.paid)}</span></div>
      <div class="kv"><span>المتبقي</span><span class="num">${fmtMoney(purchaseTotal(p) - p.paid)}</span></div>${p.note ? `<div class="muted mt-8">ملاحظة: ${esc(p.note)}</div>` : ''}`,
    footer: '<button class="btn" data-close>إغلاق</button>',
  });
}

function openPurchaseForm() {
  let lines = [{ inventoryId: S.inventory[0].id, qty: 1, unit: defUnit(S.inventory[0], 'purchase'), price: '' }];
  const total = () => { let t = 0; lines.forEach((l) => { const pr = parseEgp(String(l.price || '0')); const q = Number(l.qty); if (!Number.isNaN(pr) && q > 0) t += Math.round(q * pr); }); return t; };
  openModal({
    title: 'فاتورة شراء جديدة', size: 'lg',
    body: `<div class="form-grid">${field('المورد *', `<select class="select" name="supplier">${options(S.suppliers.filter((s) => s.active), '')}</select>`)}${field('التاريخ', `<input class="input" type="date" name="date" value="${dayKey(new Date())}">`)}</div>
      <div class="lbl-t mt-14 mb-8">الأصناف (سعر الوحدة بالجنيه لكل وحدة مختارة)</div><div id="lines"></div>
      <button class="btn btn-sm mt-8" data-addline>${icon('plus')} إضافة سطر</button>
      <div class="form-grid mt-14">${field('المبلغ المدفوع (ج.م) — سجل فقط', '<input class="input" name="paid" inputmode="decimal" value="0">')}${field('الحالة عند الحفظ', '<select class="select" name="status"><option value="draft">مسودة</option><option value="received">استلام فوري</option></select>')}${field('ملاحظة', '<input class="input" name="note">')}</div>
      <div class="card mt-14"><div class="card-b"><div class="kv total"><span>الإجمالي</span><span class="num" id="ptotal"></span></div></div></div><div class="err-t" id="perr"></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      const draw = () => {
        el.querySelector('#lines').innerHTML = lines.map((l, i) => { const it = invById(l.inventoryId); return `<div class="pay-row" style="grid-template-columns:1.4fr 80px 100px 110px 34px" data-i="${i}">
          <select class="select" data-f="inv">${options(S.inventory.filter((x) => x.active), l.inventoryId)}</select>
          <input class="input" data-f="qty" inputmode="decimal" value="${esc(l.qty)}" placeholder="الكمية">
          <select class="select" data-f="unit">${unitOptions(it, l.unit)}</select>
          <input class="input" data-f="price" inputmode="decimal" value="${esc(l.price)}" placeholder="سعر الوحدة">
          <button class="btn btn-ghost btn-icon btn-sm" data-rm style="color:var(--red)" ${lines.length === 1 ? 'disabled' : ''}>${icon('trash')}</button></div>`; }).join('');
        el.querySelector('#ptotal').textContent = fmtMoney(total());
      };
      draw();
      el.querySelector('[data-addline]').addEventListener('click', () => { const it = S.inventory[0]; lines.push({ inventoryId: it.id, qty: 1, unit: defUnit(it, 'purchase'), price: '' }); draw(); });
      el.querySelector('#lines').addEventListener('change', (e) => { const r = e.target.closest('[data-i]'); if (!r) return; const l = lines[Number(r.dataset.i)]; const f = e.target.dataset.f; if (f === 'inv') { l.inventoryId = e.target.value; l.unit = defUnit(invById(l.inventoryId), 'purchase'); draw(); } else if (f === 'unit') l.unit = e.target.value; });
      el.querySelector('#lines').addEventListener('input', (e) => { const r = e.target.closest('[data-i]'); if (!r) return; const f = e.target.dataset.f; if (f === 'qty' || f === 'price') { lines[Number(r.dataset.i)][f] = e.target.value; el.querySelector('#ptotal').textContent = fmtMoney(total()); } });
      el.querySelector('#lines').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b && lines.length > 1) { lines.splice(Number(b.closest('[data-i]').dataset.i), 1); draw(); } });
      el.querySelector('[data-ok]').addEventListener('click', () => {
        const d = formData(el);
        const out = [];
        for (const l of lines) {
          const q = Number(String(l.qty).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
          const pr = parseEgp(String(l.price || ''));
          if (!(q > 0) || Number.isNaN(pr) || pr < 0) { el.querySelector('#perr').textContent = 'تحقق من الكميات والأسعار في كل الأسطر'; return; }
          if (!decimalsOk(q, l.unit)) { el.querySelector('#perr').textContent = `عدد المنازل العشرية غير مسموح للوحدة ${UOM[l.unit].name}`; return; }
          out.push({ inventoryId: l.inventoryId, qty: q, unit: l.unit, unitPrice: pr });
        }
        if (new Set(out.map((x) => x.inventoryId)).size !== out.length) { el.querySelector('#perr').textContent = 'يوجد صنف مكرر في الأسطر'; return; }
        const paid = parseEgp(d.paid || '0');
        const tt = sum(out, (l) => Math.round(l.qty * l.unitPrice));
        if (Number.isNaN(paid) || paid < 0 || paid > tt) { el.querySelector('#perr').textContent = 'المبلغ المدفوع غير صحيح أو يتجاوز الإجمالي'; return; }
        if (!d.supplier) { el.querySelector('#perr').textContent = 'اختر المورد'; return; }
        close();
        let newId = null;
        commit((s) => { const p = { id: uid('pu'), no: nextNo(s, 'purchase'), supplierId: d.supplier, date: d.date || dayKey(new Date()), status: 'draft', lines: out, paid, note: d.note.trim() }; s.purchases.push(p); newId = p.id; });
        if (d.status === 'received') receivePurchase(newId); else toast('تم حفظ المسودة', 'ok');
      });
    },
  });
}

// ===== الموردون =====
PAGES.suppliers = {
  render() {
    const adj = can('inventory.adjust');
    return `${pageHead('الموردون', `<button class="btn btn-primary" data-add ${adj ? '' : 'disabled'}>${icon('plus')} إضافة مورد</button>`)}${demoNote('الأرصدة تقديرية: الرصيد الافتتاحي + مشتريات مستلمة − المدفوع المسجّل، وهي بيانات عرض.')}
      ${dataTable({
        id: 'suppliers', rows: S.suppliers, pageSize: 10, search: (s) => `${s.name} ${s.phone} ${s.email}`, empty: 'لا يوجد موردون',
        columns: [
          { label: 'المورد', render: (s) => `<b>${esc(s.name)}</b>${s.notes ? `<div class="muted xs">${esc(s.notes)}</div>` : ''}`, sort: (s) => s.name },
          { label: 'الهاتف', render: (s) => `<span class="ltr">${esc(s.phone)}</span>` },
          { label: 'العنوان', render: (s) => esc(s.address) || '—' },
          { label: 'الرصيد (تجريبي)', render: (s) => { const b = supplierBalance(S, s.id); return `<span class="num ${b > 0 ? 'neg-num' : ''}">${fmtMoney(b)}</span>`; }, sort: (s) => supplierBalance(S, s.id) },
          { label: 'الحالة', render: (s) => (s.active ? badge('نشط', 'green') : badge('موقوف', 'gray')) },
          { label: '', render: () => `<div class="actions"><button class="btn btn-sm" data-act="view">عرض</button><button class="btn btn-sm" data-act="edit" ${adj ? '' : 'disabled'}>${icon('edit')}</button></div>` },
        ],
      })}`;
  },
  bind(root) {
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', () => openSupplierForm(null));
    bindTable(root, 'suppliers', (act, s) => { if (act === 'edit') openSupplierForm(s); if (act === 'view') viewSupplier(s); });
  },
};

function openSupplierForm(s) {
  const isNew = !s;
  const c = s || { name: '', phone: '', email: '', address: '', notes: '', openingBalance: 0, active: true };
  openModal({
    title: isNew ? 'إضافة مورد' : `تعديل: ${esc(c.name)}`, size: 'lg',
    body: `<div class="form-grid">${field('الاسم *', `<input class="input" name="name" value="${esc(c.name)}">`)}${field('الهاتف *', `<input class="input" name="phone" value="${esc(c.phone)}" inputmode="tel">`)}${field('البريد الإلكتروني', `<input class="input" name="email" value="${esc(c.email)}" type="email">`)}${field('العنوان', `<input class="input" name="address" value="${esc(c.address)}">`)}${field('رصيد افتتاحي (ج.م)', `<input class="input" name="open" inputmode="decimal" value="${egpToInput(c.openingBalance)}">`)}<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> نشط</label>${field('ملاحظات', `<textarea class="textarea" name="notes">${esc(c.notes)}</textarea>`, 'full')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        let bad = false;
        if (!d.name.trim()) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (!/^[0-9+\-\s]{7,}$/.test(d.phone.trim())) { markInvalid(el, 'phone', 'رقم هاتف غير صحيح'); bad = true; }
        if (d.email.trim() && !/^\S+@\S+\.\S+$/.test(d.email.trim())) { markInvalid(el, 'email', 'بريد غير صحيح'); bad = true; }
        const ob = d.open.trim() === '' ? 0 : parseEgp(d.open);
        if (Number.isNaN(ob)) { markInvalid(el, 'open', 'قيمة غير صحيحة'); bad = true; }
        if (bad) return;
        close();
        const next = { name: d.name.trim(), phone: d.phone.trim(), email: d.email.trim(), address: d.address.trim(), notes: d.notes.trim(), openingBalance: ob, active: d.active };
        commit((st) => { if (isNew) st.suppliers.push({ id: uid('s'), ...next }); else Object.assign(st.suppliers.find((x) => x.id === s.id), next); });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

function viewSupplier(s) {
  const ps = S.purchases.filter((p) => p.supplierId === s.id).sort((a, b) => b.date.localeCompare(a.date));
  openModal({
    title: esc(s.name), size: 'lg',
    body: `<div class="grid g2 mb-14"><div><div class="kv"><span>الهاتف</span><span class="ltr">${esc(s.phone)}</span></div><div class="kv"><span>البريد</span><span>${esc(s.email) || '—'}</span></div><div class="kv"><span>العنوان</span><span>${esc(s.address) || '—'}</span></div><div class="kv"><span>ملاحظات</span><span>${esc(s.notes) || '—'}</span></div></div>
      <div><div class="kv"><span>رصيد افتتاحي</span><span class="num">${fmtMoney(s.openingBalance)}</span></div><div class="kv total"><span>الرصيد الحالي (تجريبي)</span><span class="num">${fmtMoney(supplierBalance(S, s.id))}</span></div></div></div>
      <h4 class="mb-8">سجل المشتريات</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الفاتورة</th><th>التاريخ</th><th>الإجمالي</th><th>المدفوع</th><th>الحالة</th></tr></thead><tbody>
      ${ps.map((p) => `<tr><td>${esc(p.no)}</td><td>${dOnly(p.date + 'T12:00:00')}</td><td class="num">${fmtMoney(purchaseTotal(p))}</td><td class="num">${fmtMoney(p.paid)}</td><td>${badge(PUR_LABEL[p.status], PUR_KIND[p.status])}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('لا توجد مشتريات')}</td></tr>`}</tbody></table></div>`,
    footer: '<button class="btn" data-close>إغلاق</button>',
  });
}

// ===== المصروفات =====
const EXP_CATS = ['إيجار', 'رواتب', 'كهرباء ومياه', 'صيانة', 'مستلزمات', 'تسويق', 'اشتراكات', 'أخرى'];

PAGES.expenses = {
  render() {
    const id = 'expenses';
    tableStates[id] = tableStates[id] || { q: '', sort: 3, dir: -1, page: 1, f: {} };
    const f = tableStates[id].f || (tableStates[id].f = {});
    let rows = S.expenses.slice();
    if (f.cat) rows = rows.filter((e) => e.category === f.cat);
    if (f.from) rows = rows.filter((e) => e.date >= f.from);
    if (f.to) rows = rows.filter((e) => e.date <= f.to);
    const active = rows.filter((e) => !e.cancelled);
    const total = sum(active, (e) => e.amount);
    const cats = [...new Set([...EXP_CATS, ...S.expenses.map((e) => e.category)])];
    return `${pageHead('المصروفات', `<button class="btn btn-primary" data-add>${icon('plus')} إضافة مصروف</button>`)}
      <div class="stats">${statCard('إجمالي المصروفات (حسب الفلاتر)', fmtMoney(total), 'red', 'expenses')}${statCard('عدد السجلات', fmtInt(active.length), 'blue', 'orders')}${statCard('أكبر فئة', (() => { const m = {}; active.forEach((e) => { m[e.category] = (m[e.category] || 0) + e.amount; }); const t = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return t ? esc(t[0]) : '—'; })(), 'amber', 'chart')}</div>
      ${dataTable({
        id, rows, pageSize: 10, search: (e) => `${e.name} ${e.category} ${e.note}`, empty: 'لا توجد مصروفات',
        filtersHtml: `${tblSelectFilter(id, 'cat', 'كل الفئات', cats.map((c) => [c, c]))}<input class="input" type="date" style="width:auto" data-date="from" value="${f.from || ''}"><input class="input" type="date" style="width:auto" data-date="to" value="${f.to || ''}">`,
        columns: [
          { label: 'المصروف', render: (e) => `<span style="${e.cancelled ? 'text-decoration:line-through;color:var(--muted)' : 'font-weight:700'}">${esc(e.name)}</span>${e.note ? `<div class="muted xs">${esc(e.note)}</div>` : ''}`, sort: (e) => e.name },
          { label: 'الفئة', render: (e) => esc(e.category), sort: (e) => e.category },
          { label: 'المبلغ', render: (e) => `<span class="num ${e.cancelled ? 'muted' : ''}">${fmtMoney(e.amount)}</span>`, sort: (e) => e.amount },
          { label: 'التاريخ', render: (e) => dOnly(e.date + 'T12:00:00'), sort: (e) => e.date },
          { label: 'طريقة الدفع', render: (e) => METHOD_LABEL[e.method] || e.method },
          { label: 'الحالة', render: (e) => (e.cancelled ? badge('ملغي', 'gray') : badge('فعّال', 'green')) },
          { label: '', render: (e) => `<div class="actions"><button class="btn btn-sm" data-act="edit" ${e.cancelled ? 'disabled' : ''}>${icon('edit')}</button><button class="btn btn-sm btn-danger" data-act="cancel" ${e.cancelled ? 'disabled' : ''}>إلغاء</button></div>` },
        ],
      })}`;
  },
  bind(root) {
    root.querySelector('[data-add]').addEventListener('click', () => openExpenseForm(null));
    bindTable(root, 'expenses', (act, e) => {
      if (act === 'edit') openExpenseForm(e);
      if (act === 'cancel') confirmDialog({ title: 'إلغاء المصروف', message: `إلغاء «${esc(e.name)}»؟ لن يُحتسب في التقارير.`, confirmText: 'إلغاء المصروف', danger: true, onConfirm: () => commit((s) => { s.expenses.find((x) => x.id === e.id).cancelled = true; }) });
    });
    bindFilters(root);
    root.querySelectorAll('[data-date]').forEach((i) => i.addEventListener('change', () => { tableStates.expenses.f[i.dataset.date] = i.value; tableStates.expenses.page = 1; render(); }));
  },
};

function openExpenseForm(e) {
  const isNew = !e;
  const c = e || { name: '', category: EXP_CATS[0], amount: 0, date: dayKey(new Date()), method: 'cash', note: '' };
  const cats = [...new Set([...EXP_CATS, ...S.expenses.map((x) => x.category)])];
  openModal({
    title: isNew ? 'إضافة مصروف' : 'تعديل المصروف', size: 'sm',
    body: `<div class="col">${field('اسم المصروف *', `<input class="input" name="name" value="${esc(c.name)}">`)}${field('الفئة', `<select class="select" name="category">${cats.map((x) => `<option ${x === c.category ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`)}${field('المبلغ (ج.م) *', `<input class="input" name="amount" inputmode="decimal" value="${c.amount ? egpToInput(c.amount) : ''}">`)}${field('التاريخ', `<input class="input" type="date" name="date" value="${c.date}">`)}${field('طريقة الدفع', `<select class="select" name="method">${['cash', 'card', 'wallet', 'other'].map((m) => `<option value="${m}" ${m === c.method ? 'selected' : ''}>${METHOD_LABEL[m]}</option>`).join('')}</select>`)}${field('ملاحظات', `<input class="input" name="note" value="${esc(c.note)}">`)}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const amt = parseEgp(d.amount);
        let bad = false;
        if (!d.name.trim()) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (Number.isNaN(amt) || amt <= 0) { markInvalid(el, 'amount', 'أدخل مبلغًا صحيحًا'); bad = true; }
        if (!d.date) { markInvalid(el, 'date', 'التاريخ مطلوب'); bad = true; }
        if (bad) return;
        close();
        const next = { name: d.name.trim(), category: d.category, amount: amt, date: d.date, at: d.date + 'T12:00:00', method: d.method, note: d.note.trim() };
        commit((s) => { if (isNew) s.expenses.push({ id: uid('ex'), cancelled: false, ...next }); else Object.assign(s.expenses.find((x) => x.id === e.id), next); });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

// ===== العملاء =====
PAGES.customers = {
  render() {
    return `${pageHead('العملاء', `<button class="btn btn-primary" data-add>${icon('plus')} إضافة عميل</button>`)}${demoNote('الأرصدة المعروضة قيم تجريبية فقط ولا ترتبط بنظام ائتمان حقيقي.')}
      ${dataTable({
        id: 'customers', rows: S.customers, pageSize: 10, search: (c) => `${c.name} ${c.phone} ${c.email}`, empty: 'لا يوجد عملاء',
        columns: [
          { label: 'العميل', render: (c) => `<b>${esc(c.name)}</b>${c.notes ? `<div class="muted xs">${esc(c.notes)}</div>` : ''}`, sort: (c) => c.name },
          { label: 'الهاتف', render: (c) => `<span class="ltr">${esc(c.phone)}</span>` },
          { label: 'البريد', render: (c) => esc(c.email) || '—' },
          { label: 'عدد الطلبات', render: (c) => fmtInt(S.orders.filter((o) => o.customerId === c.id && o.status === 'completed').length), sort: (c) => S.orders.filter((o) => o.customerId === c.id).length },
          { label: 'الرصيد (تجريبي)', render: (c) => `<span class="num">${fmtMoney(c.balance)}</span>` },
          { label: '', render: () => `<div class="actions"><button class="btn btn-sm" data-act="view">عرض</button><button class="btn btn-sm" data-act="edit">${icon('edit')}</button></div>` },
        ],
      })}`;
  },
  bind(root) {
    root.querySelector('[data-add]').addEventListener('click', () => openCustomerForm(null));
    bindTable(root, 'customers', (act, c) => { if (act === 'edit') openCustomerForm(c); if (act === 'view') viewCustomer(c); });
  },
};

function openCustomerForm(c) {
  const isNew = !c;
  const cur = c || { name: '', phone: '', email: '', notes: '', balance: 0 };
  openModal({
    title: isNew ? 'إضافة عميل' : `تعديل: ${esc(cur.name)}`, size: 'sm',
    body: `<div class="col">${field('الاسم *', `<input class="input" name="name" value="${esc(cur.name)}">`)}${field('الهاتف *', `<input class="input" name="phone" value="${esc(cur.phone)}" inputmode="tel">`)}${field('البريد الإلكتروني', `<input class="input" name="email" type="email" value="${esc(cur.email)}">`)}${field('ملاحظات', `<textarea class="textarea" name="notes">${esc(cur.notes)}</textarea>`)}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        let bad = false;
        if (!d.name.trim()) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (!/^[0-9+\-\s]{7,}$/.test(d.phone.trim())) { markInvalid(el, 'phone', 'رقم هاتف غير صحيح'); bad = true; }
        if (d.email.trim() && !/^\S+@\S+\.\S+$/.test(d.email.trim())) { markInvalid(el, 'email', 'بريد غير صحيح'); bad = true; }
        if (bad) return;
        close();
        const next = { name: d.name.trim(), phone: d.phone.trim(), email: d.email.trim(), notes: d.notes.trim() };
        commit((s) => { if (isNew) s.customers.push({ id: uid('c'), balance: 0, active: true, ...next }); else Object.assign(s.customers.find((x) => x.id === c.id), next); });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

function viewCustomer(c) {
  const os = S.orders.filter((o) => o.customerId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  openModal({
    title: esc(c.name), size: 'lg',
    body: `<div class="row wrap mb-14"><span class="ltr">${esc(c.phone)}</span><span class="muted">${esc(c.email)}</span><span class="grow"></span><span>الرصيد (تجريبي): <b class="num">${fmtMoney(c.balance)}</b></span></div>${c.notes ? `<div class="muted mb-8">${esc(c.notes)}</div>` : ''}
      <h4 class="mb-8">سجل الطلبات (${fmtInt(os.length)})</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الفاتورة</th><th>التاريخ</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>
      ${os.slice(0, 20).map((o) => `<tr><td>${esc(o.no)}</td><td>${dt(o.createdAt)}</td><td class="num">${fmtMoney(o.total)}</td><td>${badge(STATUS_LABEL[o.status], STATUS_KIND[o.status])}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('لا توجد طلبات')}</td></tr>`}</tbody></table></div>`,
    footer: '<button class="btn" data-close>إغلاق</button>',
  });
}

// ===== 74-admin.js =====
// ---------------------------------------------------------------------------
// المستخدمون — التقارير — الخزنة — المرتجعات — الطابعات — الإعدادات — النسخ الاحتياطي
// ---------------------------------------------------------------------------
const SIM_SEC = 'محاكاة واجهة فقط: هذه الصلاحيات لا توفر حماية حقيقية. يجب أن يفرض الباك إند الصلاحيات والتحقق لاحقًا.';

// ===== المستخدمون والصلاحيات =====
PAGES.users = {
  render() {
    const roles = S.roles;
    const group = (g) => ALL_PERMS.filter((p) => p.group === g);
    const matrix = ['الشاشات', 'العمليات الحساسة'].map((g) => `<div class="pg">${g}</div>` + group(g).map((p) => `<div>${esc(p.label)}</div>` + roles.map((r) => `<div class="pc"><input type="checkbox" data-perm="${r.id}|${p.key}" ${hasPerm(r.permissions, p.key) ? 'checked' : ''} ${r.id === 'r_admin' ? 'disabled title="المدير يملك كل الصلاحيات"' : ''} style="width:18px;height:18px;accent-color:var(--primary)"></div>`).join('')).join('')).join('');
    return `${pageHead('المستخدمون والصلاحيات', `<button class="btn btn-primary" data-add>${icon('plus')} إضافة مستخدم</button>`)}${demoNote(SIM_SEC)}
      ${dataTable({
        id: 'users', rows: S.users, pageSize: 10, search: (u) => `${u.name} ${u.username}`, empty: 'لا يوجد مستخدمون',
        columns: [
          { label: 'الاسم', render: (u) => `<b>${esc(u.name)}</b>${u.id === S.auth.userId ? ' <span class="badge b-blue">أنت</span>' : ''}`, sort: (u) => u.name },
          { label: 'اسم المستخدم', render: (u) => `<span class="ltr">${esc(u.username)}</span>` },
          { label: 'الدور', render: (u) => esc((S.roles.find((r) => r.id === u.roleId) || {}).label || '—') + (Array.isArray(u.perms) ? ' <span class="badge b-blue">صلاحيات مخصصة</span>' : '') },
          { label: 'الحالة', render: (u) => (u.active ? badge('نشط', 'green') : badge('موقوف', 'gray')) },
          { label: 'آخر نشاط (تجريبي)', render: (u) => dt(u.lastActive) },
          { label: '', render: () => `<div class="actions"><button class="btn btn-sm" data-act="perms">${icon('lock')} الصلاحيات</button><button class="btn btn-sm" data-act="pw">كلمة المرور</button><button class="btn btn-sm" data-act="edit">${icon('edit')}</button><button class="btn btn-sm" data-act="toggle">تفعيل/إيقاف</button></div>` },
        ],
      })}
      <div class="card mt-14"><div class="card-h">مصفوفة الصلاحيات</div><div class="card-b"><div class="perm-grid"><div class="ph" style="justify-content:flex-start">الصلاحية</div>${roles.map((r) => `<div class="ph">${esc(r.label)}</div>`).join('')}${matrix}</div>
      <div class="hint mt-8">التغيير يحفظ فورًا في بيانات العرض ويؤثر على القائمة والأزرار عند التسجيل بالمستخدم المعني. صلاحيات المدير ثابتة.</div></div></div>`;
  },
  bind(root) {
    root.querySelector('[data-add]').addEventListener('click', () => openUserForm(null));
    bindTable(root, 'users', (act, u) => {
      if (act === 'edit') openUserForm(u);
      if (act === 'perms') openUserPerms(u);
      if (act === 'pw') openPasswordDialog(u);
      if (act === 'toggle') {
        if (u.id === S.auth.userId) return toast('لا يمكنك إيقاف حسابك الحالي', 'err');
        commit((s) => { const x = s.users.find((y) => y.id === u.id); x.active = !x.active; });
      }
    });
    root.querySelectorAll('[data-perm]').forEach((c) => c.addEventListener('change', () => {
      const [rid, key] = c.dataset.perm.split('|');
      commit((s) => {
        const r = s.roles.find((x) => x.id === rid);
        r.permissions = c.checked ? [...new Set([...r.permissions, key])] : r.permissions.filter((k) => k !== key);
      });
    }));
  },
};

function openPasswordDialog(u) {
  openModal({
    title: `تغيير كلمة مرور: ${esc(u.name)}`, size: 'sm',
    body: `<div class="col">${field('كلمة المرور الجديدة * (6 أحرف على الأقل)', '<input class="input" type="password" name="pw" autocomplete="new-password">')}${field('تأكيد كلمة المرور', '<input class="input" type="password" name="pw2" autocomplete="new-password">')}<div class="hint">تُحفظ في هذا المتصفح بتشفير بسيط وليست حماية حقيقية.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        if (d.pw.length < 6) return markInvalid(el, 'pw', 'كلمة المرور 6 أحرف على الأقل');
        if (d.pw !== d.pw2) return markInvalid(el, 'pw2', 'كلمتا المرور غير متطابقتين');
        close();
        commit((s) => { setPassword(s.users.find((x) => x.id === u.id), d.pw); });
        toast('تم تغيير كلمة المرور', 'ok');
      });
    },
  });
}

function openUserPerms(u) {
  if (u.roleId === 'r_admin') return toast('صلاحيات مدير النظام ثابتة', 'warn');
  const self = u.id === S.auth.userId;
  const base = userPerms(u) || [];
  const sel = new Set(base.includes('*') ? ALL_PERMS.map((p) => p.key) : base);
  const groups = ['الشاشات', 'العمليات الحساسة'];
  const draw = (el) => {
    el.querySelectorAll('[data-p]').forEach((c) => { c.checked = sel.has(c.dataset.p) || (self && c.dataset.p === 'page.users'); });
  };
  openModal({
    title: `صلاحيات: ${esc(u.name)}`, size: 'lg',
    body: `<div class="row wrap mb-14"><button class="btn btn-sm" data-preset="tables">الطاولات فقط</button><button class="btn btn-sm" data-preset="cashier">كاشير كامل</button><button class="btn btn-sm" data-preset="none">إلغاء الكل</button><button class="btn btn-sm btn-ghost" data-preset="role">رجوع لصلاحيات الدور</button></div>
      ${groups.map((g) => `<h4 class="mb-8">${g}</h4><div class="chips mb-14">${ALL_PERMS.filter((p) => p.group === g).map((p) => `<label class="chip check"><input type="checkbox" data-p="${p.key}" ${self && p.key === 'page.users' ? 'disabled' : ''}> ${esc(p.label)}</label>`).join('')}</div>`).join('')}
      <div class="hint">الصلاحيات المخصصة تتقدم على صلاحيات دور «${esc((S.roles.find((r) => r.id === u.roleId) || {}).label || '')}». «الطاولات فقط» يخلّي المستخدم يرى شاشة الطاولات فقط؛ فتح الطلب أو الدفع يحتاج صلاحية الكاشير. محاكاة واجهة وليست حماية حقيقية.</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ الصلاحيات</button>',
    onMount(el, close) {
      draw(el);
      el.querySelectorAll('[data-p]').forEach((c) => c.addEventListener('change', () => { if (c.checked) sel.add(c.dataset.p); else sel.delete(c.dataset.p); }));
      el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.preset;
        if (k === 'role') { close(); commit((st) => { delete st.users.find((x) => x.id === u.id).perms; }); return toast('رجع المستخدم لصلاحيات دوره', 'ok'); }
        sel.clear();
        if (k === 'tables') sel.add('page.tables');
        if (k === 'cashier') ((S.roles.find((r) => r.id === 'r_cashier') || {}).permissions || []).forEach((x) => sel.add(x));
        draw(el);
      }));
      el.querySelector('[data-ok]').addEventListener('click', () => {
        const perms = [...el.querySelectorAll('[data-p]')].filter((c) => c.checked || c.disabled).map((c) => c.dataset.p);
        if (!perms.some((x) => x.startsWith('page.'))) return toast('اختر شاشة واحدة على الأقل', 'err');
        close();
        commit((st) => { st.users.find((x) => x.id === u.id).perms = perms; });
        toast('تم حفظ صلاحيات المستخدم', 'ok');
      });
    },
  });
}

function openUserForm(u) {
  const isNew = !u;
  const cur = u || { name: '', username: '', roleId: 'r_cashier', active: true };
  openModal({
    title: isNew ? 'إضافة مستخدم' : `تعديل: ${esc(cur.name)}`, size: 'sm',
    body: `<div class="col">${field('الاسم *', `<input class="input" name="name" value="${esc(cur.name)}">`)}${field('اسم المستخدم * (حروف لاتينية/أرقام)', `<input class="input" name="username" value="${esc(cur.username)}" autocapitalize="off" ${isNew ? '' : 'disabled'}>`)}${field('الدور', `<select class="select" name="roleId">${options(S.roles, cur.roleId, 'id', 'label')}</select>`)}${field(isNew ? 'كلمة المرور * (6 أحرف على الأقل)' : 'كلمة مرور جديدة (اتركها فارغة بدون تغيير)', '<input class="input" type="password" name="pw" autocomplete="new-password">')}${field('تأكيد كلمة المرور', '<input class="input" type="password" name="pw2" autocomplete="new-password">')}<label class="check"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> نشط</label>
      <div class="hint">كلمة المرور تُحفظ في هذا المتصفح بتشفير بسيط وليست حماية حقيقية. الحماية الفعلية تحتاج Backend.</div></div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>حفظ</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        if (!d.name.trim()) return markInvalid(el, 'name', 'الاسم مطلوب');
        const un = (isNew ? d.username : cur.username).trim().toLowerCase();
        if (!/^[a-z0-9_.-]{3,}$/.test(un)) return markInvalid(el, 'username', 'حروف لاتينية/أرقام (3 على الأقل)');
        if (isNew && S.users.some((x) => x.username === un)) return markInvalid(el, 'username', 'اسم المستخدم مستخدم');
        if ((isNew || d.pw) && d.pw.length < 6) return markInvalid(el, 'pw', 'كلمة المرور 6 أحرف على الأقل');
        if (d.pw !== d.pw2) return markInvalid(el, 'pw2', 'كلمتا المرور غير متطابقتين');
        if (!isNew && u.id === S.auth.userId && !d.active) return markInvalid(el, 'name', 'لا يمكنك إيقاف حسابك الحالي');
        close();
        commit((s) => {
          if (isNew) { const nu = { id: uid('u'), name: d.name.trim(), username: un, roleId: d.roleId, active: d.active, lastActive: new Date().toISOString() }; setPassword(nu, d.pw); s.users.push(nu); }
          else { const x = s.users.find((y) => y.id === u.id); Object.assign(x, { name: d.name.trim(), roleId: d.roleId, active: d.active }); if (d.pw) setPassword(x, d.pw); }
        });
        toast('تم الحفظ', 'ok');
      });
    },
  });
}

// ===== التقارير =====
PAGES.reports = {
  render() {
    const R = UI.reports;
    const custom = R.period === 'custom' ? { from: R.from || dayKey(new Date()), to: R.to || dayKey(new Date()) } : null;
    const range = periodRange(R.period, custom);
    const k = kpis(S, range);
    const orders = k.orders;
    const tabs = [['sales', 'المبيعات'], ['profit', 'الربحية'], ['inventory', 'المخزون'], ['purchases', 'الموردون والمشتريات'], ['staff', 'الكاشير'], ['audit', 'سجل العمليات']];
    const periodBtns = [['today', 'اليوم'], ['week', 'أسبوعي'], ['month', 'شهري'], ['custom', 'نطاق مخصص']];
    let body = '';
    if (R.tab === 'sales') {
      const catSales = {};
      orders.forEach((o) => o.items.forEach((i) => { const p = S.products.find((x) => x.id === i.productId); const c = p ? categoryName(p.categoryId) : '—'; catSales[c] = (catSales[c] || 0) + i.totalAlloc - i.refundedAmount; }));
      const pay = paymentBreakdown(orders);
      const days = groupByDay(orders, range);
      body = `<div class="stats">${statCard('إجمالي المبيعات', fmtMoney(k.total), 'blue', 'money')}${statCard('عدد الفواتير', fmtInt(k.count), 'green', 'orders')}${statCard('متوسط الفاتورة', fmtMoney(k.avg), 'amber', 'chart')}${statCard('الخصومات', fmtMoney(k.discounts), 'gray', 'alert')}${statCard('الضريبة المحصّلة', fmtMoney(k.tax), 'gray', 'info', 'ليست إيرادًا')}${statCard('المرتجعات', fmtMoney(k.refundTotal), 'red', 'refunds')}</div>
        <div class="grid g-main mb-14"><div class="card"><div class="card-h">المبيعات حسب اليوم</div><div class="card-b">${days.length > 1 ? lineChart(days) : emptyState('اختر فترة أطول لعرض المخطط', '📈')}</div></div>
        <div class="card"><div class="card-h">طرق الدفع</div><div class="card-b">${donutChart(Object.entries(pay).map(([m, v]) => ({ label: METHOD_LABEL[m] || m, value: v })))}</div></div></div>
        <div class="grid g2"><div class="card"><div class="card-h">الأصناف الأكثر مبيعًا</div><div class="card-b">${barList(topProducts(orders, 8).map((t) => ({ label: `${t.emoji} ${t.name}`, value: t.qty })), (v) => fmtInt(v))}</div></div>
        <div class="card"><div class="card-h">المبيعات حسب التصنيف (بعد المرتجعات)</div><div class="card-b">${barList(Object.entries(catSales).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value))}</div></div></div>`;
    } else if (R.tab === 'profit') {
      body = `<div class="stats">${statCard('صافي المبيعات (بدون ضريبة)', fmtMoney(k.netAfterRefunds), 'blue', 'money', 'بعد الخصومات والمرتجعات')}${statCard('تكلفة البضاعة المباعة', fmtMoney(k.cogs), 'amber', 'box', 'لقطة وقت البيع')}${statCard('الربح الإجمالي التقديري', fmtMoney(k.grossProfit), 'green', 'up')}${statCard('المصروفات التشغيلية', fmtMoney(k.expenses), 'red', 'expenses')}${statCard('صافي الربح التقديري', fmtMoney(k.netProfit), k.netProfit >= 0 ? 'green' : 'red', 'chart')}</div>
        <div class="card"><div class="card-b"><div class="kv"><span>إجمالي الفواتير (شامل الضريبة)</span><span class="num">${fmtMoney(k.total)}</span></div><div class="kv"><span>− الضريبة المحصّلة لصالح الجهات</span><span class="num">${fmtMoney(k.tax)}</span></div><div class="kv"><span>− المرتجعات (حصة الصافي)</span><span class="num">${fmtMoney(k.net - k.netAfterRefunds)}</span></div><div class="kv"><span>= صافي المبيعات</span><b class="num">${fmtMoney(k.netAfterRefunds)}</b></div><div class="kv"><span>− تكلفة البضاعة المباعة (بعد استرجاع تكلفة المرتجعات)</span><span class="num">${fmtMoney(k.cogs)}</span></div><div class="kv"><span>= الربح الإجمالي</span><b class="num">${fmtMoney(k.grossProfit)}</b></div><div class="kv"><span>− المصروفات التشغيلية</span><span class="num">${fmtMoney(k.expenses)}</span></div><div class="kv total"><span>= صافي الربح التقديري</span><span class="num">${fmtMoney(k.netProfit)}</span></div></div></div>
        <div class="hint mt-8">افتراضات: لا يشمل الصافي رواتب أو إيجارًا إلا إذا سُجّلت في المصروفات. تكلفة المكونات تشمل التكلفة الإضافية المباشرة. الأرقام تقديرية من بيانات العرض.</div>`;
    } else if (R.tab === 'inventory') {
      const mv = S.movements.filter((m) => new Date(m.at).getTime() >= range[0] && new Date(m.at).getTime() <= range[1]);
      const by = (t) => sum(mv.filter((m) => m.type === t), (m) => { const i = invById(m.inventoryId); return Math.round(Math.abs(m.delta) * (i ? i.costPerBase : 0)); });
      body = `<div class="stats">${statCard('قيمة المخزون الحالي', fmtMoney(sum(S.inventory, (i) => Math.round(Math.max(0, i.qty) * i.costPerBase))), 'blue', 'inventory')}${statCard('أصناف منخفضة', fmtInt(lowStockItems(S).length), 'red', 'alert')}${statCard('قيمة الاستهلاك (بيع)', fmtMoney(by('sale')), 'amber', 'box')}${statCard('قيمة المشتريات المستلمة', fmtMoney(by('receive')), 'green', 'download')}${statCard('قيمة الهالك', fmtMoney(by('waste')), 'red', 'trash')}${statCard('عدد التسويات', fmtInt(mv.filter((m) => m.type === 'adjust' || m.type === 'count').length), 'gray', 'edit')}</div>
        <div class="card"><div class="card-h">حركة المخزون في الفترة (${fmtInt(mv.length)})</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>الصنف</th><th>النوع</th><th>الكمية</th><th>السبب</th></tr></thead><tbody>${mv.slice(0, 40).map((m) => { const i = invById(m.inventoryId); return `<tr><td>${dt(m.at)}</td><td>${esc(i ? i.name : '—')}</td><td>${badge(MOVE_LABEL[m.type], m.delta < 0 ? 'red' : 'green')}</td><td class="num">${movQty(m, i)}</td><td>${esc(m.reason)}</td></tr>`; }).join('') || `<tr><td colspan="5">${emptyState('لا توجد حركات في الفترة')}</td></tr>`}</tbody></table></div></div>`;
    } else if (R.tab === 'purchases') {
      const ps = S.purchases.filter((p) => p.status !== 'cancelled' && new Date(p.date + 'T12:00:00').getTime() >= range[0] && new Date(p.date + 'T12:00:00').getTime() <= range[1]);
      const by = {};
      ps.forEach((p) => { const e = by[p.supplierId] || { total: 0, paid: 0, n: 0 }; e.total += purchaseTotal(p); e.paid += p.paid; e.n += 1; by[p.supplierId] = e; });
      body = `<div class="stats">${statCard('إجمالي المشتريات', fmtMoney(sum(ps, purchaseTotal)), 'blue', 'purchases')}${statCard('المدفوع', fmtMoney(sum(ps, (p) => p.paid)), 'green', 'money')}${statCard('المتبقي', fmtMoney(sum(ps, (p) => purchaseTotal(p) - p.paid)), 'red', 'alert')}</div>
        <div class="card"><div class="card-h">المشتريات حسب المورد</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>المورد</th><th>الفواتير</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الرصيد الكلي (تجريبي)</th></tr></thead><tbody>${Object.entries(by).map(([id, e]) => `<tr><td>${esc(supplierName(id))}</td><td class="num">${fmtInt(e.n)}</td><td class="num">${fmtMoney(e.total)}</td><td class="num">${fmtMoney(e.paid)}</td><td class="num">${fmtMoney(e.total - e.paid)}</td><td class="num">${fmtMoney(supplierBalance(S, id))}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('لا توجد مشتريات في الفترة')}</td></tr>`}</tbody></table></div></div>`;
    } else if (R.tab === 'audit') {
      const log = (S.auditLog || []).slice(0, 150);
      body = `<div class="card"><div class="card-h">سجل العمليات المهمة (آخر ${fmtInt(log.length)})</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>${log.map((l) => `<tr><td>${dt(l.at)}</td><td>${esc(l.by)}</td><td>${badge(esc(l.kind), /خطأ|غير مكتملة/.test(l.kind) ? 'red' : 'blue')}</td><td>${esc(l.detail)}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('لا توجد عمليات مسجلة بعد')}</td></tr>`}</tbody></table></div></div>`;
    } else {
      const by = {};
      orders.forEach((o) => { const e = by[o.cashier] || { n: 0, total: 0, disc: 0 }; e.n += 1; e.total += o.total; e.disc += o.discountAmount; by[o.cashier] = e; });
      const rf = {}; refundsIn(S, range).forEach((r) => { rf[r.by] = (rf[r.by] || 0) + r.amount; });
      body = `<div class="card"><div class="card-h">أداء الموظفين</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الموظف</th><th>عدد الفواتير</th><th>إجمالي المبيعات</th><th>الخصومات</th><th>المرتجعات المنفذة</th></tr></thead><tbody>${Object.entries(by).map(([n, e]) => `<tr><td><b>${esc(n)}</b></td><td class="num">${fmtInt(e.n)}</td><td class="num">${fmtMoney(e.total)}</td><td class="num">${fmtMoney(e.disc)}</td><td class="num">—</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('لا توجد بيانات')}</td></tr>`}${Object.entries(rf).map(([n, v]) => `<tr><td>${esc(n)} (اعتماد مرتجعات)</td><td></td><td></td><td></td><td class="num">${fmtMoney(v)}</td></tr>`).join('')}</tbody></table></div></div>`;
    }
    return `${pageHead('التقارير', `<button class="btn" data-csv>${icon('download')} تصدير CSV (بيانات العرض)</button>`)}${demoNote('كل التقارير من بيانات عرض محفوظة محليًا. لا تُعد أرقامًا حقيقية لنشاط تجاري.')}
      <div class="row wrap mb-14"><div class="seg">${periodBtns.map(([k2, l]) => `<button data-rp="${k2}" class="${R.period === k2 ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${R.period === 'custom' ? `<input class="input" type="date" style="width:auto" data-rf="from" value="${custom.from}"><input class="input" type="date" style="width:auto" data-rf="to" value="${custom.to}">` : ''}</div>
      <div class="tabs">${tabs.map(([k2, l]) => `<button class="tab ${R.tab === k2 ? 'on' : ''}" data-rt="${k2}">${l}</button>`).join('')}</div>${body}`;
  },
  bind(root) {
    root.querySelectorAll('[data-rp]').forEach((b) => b.addEventListener('click', () => { UI.reports.period = b.dataset.rp; render(); }));
    root.querySelectorAll('[data-rt]').forEach((b) => b.addEventListener('click', () => { UI.reports.tab = b.dataset.rt; render(); }));
    root.querySelectorAll('[data-rf]').forEach((i) => i.addEventListener('change', () => { UI.reports[i.dataset.rf] = i.value; render(); }));
    root.querySelector('[data-csv]').addEventListener('click', exportReportCsv);
  },
};

function exportReportCsv() {
  const R = UI.reports;
  const custom = R.period === 'custom' ? { from: R.from || dayKey(new Date()), to: R.to || dayKey(new Date()) } : null;
  const range = periodRange(R.period, custom);
  const k = kpis(S, range);
  const eg = (v) => (v / 100).toFixed(2);
  let rows;
  if (R.tab === 'sales') rows = [['الفاتورة', 'النوع', 'التاريخ', 'الخصم', 'الضريبة', 'الإجمالي', 'الدفع'], ...k.orders.map((o) => [o.no, ORDER_TYPES[o.type], dt(o.paidAt), eg(o.discountAmount), eg(o.taxAmount), eg(o.total), o.payments.map((p) => METHOD_LABEL[p.method]).join('+')])];
  else if (R.tab === 'profit') rows = [['البند', 'القيمة (ج.م)'], ['إجمالي الفواتير', eg(k.total)], ['الضريبة', eg(k.tax)], ['صافي المبيعات', eg(k.netAfterRefunds)], ['تكلفة البضاعة', eg(k.cogs)], ['الربح الإجمالي', eg(k.grossProfit)], ['المصروفات', eg(k.expenses)], ['صافي الربح', eg(k.netProfit)]];
  else if (R.tab === 'inventory') rows = [['الصنف', 'الكمية', 'الوحدة', 'الحد الأدنى', 'تكلفة الوحدة الأساسية'], ...S.inventory.map((i) => [i.name, i.qty, BASE_UNIT_LABEL[i.baseUnit], i.minQty, (i.costPerBase / 100).toFixed(4)])];
  else if (R.tab === 'purchases') rows = [['الفاتورة', 'المورد', 'التاريخ', 'الإجمالي', 'المدفوع', 'الحالة'], ...S.purchases.map((p) => [p.no, supplierName(p.supplierId), p.date, eg(purchaseTotal(p)), eg(p.paid), PUR_LABEL[p.status]])];
  else if (R.tab === 'audit') rows = [['الوقت', 'المستخدم', 'العملية', 'التفاصيل'], ...(S.auditLog || []).map((l) => [dt(l.at), l.by, l.kind, l.detail])];
  else { const by = {}; k.orders.forEach((o) => { const e = by[o.cashier] || { n: 0, t: 0 }; e.n += 1; e.t += o.total; by[o.cashier] = e; }); rows = [['الموظف', 'الفواتير', 'المبيعات'], ...Object.entries(by).map(([n, e]) => [n, e.n, eg(e.t)])]; }
  downloadCsv(`hyper-one-demo-${R.tab}-${dayKey(new Date())}.csv`, rows);
  toast('تم تنزيل ملف CSV (بيانات العرض)', 'ok');
}

// ===== الخزنة والورديات =====
PAGES.cashbox = {
  render() {
    const sh = currentShift();
    const sm = sh ? shiftSummary(S, sh) : null;
    const closed = S.shifts.filter((x) => x.closedAt).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    return `${pageHead('الخزنة والورديات', sh ? `<button class="btn" data-dep>${icon('plus')} إيداع</button><button class="btn" data-wd>${icon('minus')} سحب</button><button class="btn btn-danger" data-close-shift>إغلاق الوردية</button>` : '<button class="btn btn-primary" data-open-shift>فتح وردية</button>')}${demoNote('محاكاة واجهة: حسابات الوردية تتم داخل المتصفح. النقدية المتوقعة = رصيد الافتتاح + مبيعات نقدية + إيداعات − سحوبات − مرتجعات نقدية − مصروفات نقدية. البطاقة والمحفظة لا تدخل في النقدية الفعلية.')}
      ${sh ? `<div class="stats">${statCard('رصيد الافتتاح', fmtMoney(sh.openingCash), 'blue', 'cashbox')}${statCard('مبيعات نقدية', fmtMoney(sm.by.cash), 'green', 'money')}${statCard('مبيعات بطاقة', fmtMoney(sm.by.card), 'blue', 'card', 'ليست نقدًا')}${statCard('مبيعات محفظة', fmtMoney(sm.by.wallet), 'amber', 'card', 'ليست نقدًا')}${statCard('إيداعات', fmtMoney(sm.deposits), 'green', 'down')}${statCard('سحوبات', fmtMoney(sm.withdrawals), 'red', 'up')}${statCard('مرتجعات نقدية', fmtMoney(sm.cashRefunds), 'red', 'refunds', sm.otherRefunds ? `+ ${fmtMoney(sm.otherRefunds)} غير نقدي (لا تؤثر على الدرج)` : '')}${statCard('النقدية المتوقعة', fmtMoney(sm.expected), 'blue', 'cashbox')}</div>
        <div class="card mb-14"><div class="card-h">حركات الوردية الحالية — ${esc(sh.cashier)}، بدأت ${dt(sh.openedAt)}</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>النوع</th><th>المبلغ</th><th>السبب</th></tr></thead><tbody>${sm.moves.map((m) => `<tr><td>${dt(m.at)}</td><td>${m.type === 'deposit' ? badge('إيداع', 'green') : badge('سحب', 'red')}</td><td class="num">${fmtMoney(m.amount)}</td><td>${esc(m.reason)}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('لا توجد حركات يدوية')}</td></tr>`}</tbody></table></div></div>`
        : `<div class="card mb-14"><div class="card-b">${emptyState('لا توجد وردية مفتوحة. افتح وردية لبدء البيع.', '🔒')}</div></div>`}
      <div class="card"><div class="card-h">سجل الورديات</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الكاشير</th><th>الفتح</th><th>الإغلاق</th><th>رصيد الافتتاح</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th></tr></thead><tbody>
      ${closed.map((x) => `<tr><td>${esc(x.cashier)}</td><td>${dt(x.openedAt)}</td><td>${dt(x.closedAt)}</td><td class="num">${fmtMoney(x.openingCash)}</td><td class="num">${fmtMoney(x.expectedCash || 0)}</td><td class="num">${fmtMoney(x.countedCash || 0)}</td><td class="num ${x.difference < 0 ? 'neg-num' : x.difference > 0 ? 'pos-num' : ''}">${x.difference > 0 ? '+' : ''}${fmtMoney(x.difference || 0)} ${x.difference < 0 ? '(عجز)' : x.difference > 0 ? '(زيادة)' : ''}</td></tr>`).join('') || `<tr><td colspan="7">${emptyState('لا توجد ورديات سابقة')}</td></tr>`}</tbody></table></div></div>`;
  },
  bind(root) {
    const on = (s, fn) => { const b = root.querySelector(s); if (b) b.addEventListener('click', fn); };
    on('[data-open-shift]', openShiftDialog);
    on('[data-dep]', () => cashMoveDialog('deposit'));
    on('[data-wd]', () => cashMoveDialog('withdrawal'));
    on('[data-close-shift]', closeShiftDialog);
  },
};

function openShiftDialog() {
  openModal({
    title: 'فتح وردية', size: 'sm',
    body: `<div class="col">${field('الكاشير', `<input class="input" name="cashier" value="${esc(currentUser().name)}">`)}${field('رصيد الافتتاح النقدي (ج.م) *', '<input class="input" name="open" inputmode="decimal" value="500">')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>فتح الوردية</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const v = parseEgp(d.open);
        if (Number.isNaN(v) || v < 0) return markInvalid(el, 'open', 'أدخل مبلغًا صحيحًا');
        if (!d.cashier.trim()) return markInvalid(el, 'cashier', 'اسم الكاشير مطلوب');
        if (currentShift()) { close(); return toast('توجد وردية مفتوحة بالفعل', 'err'); }
        close();
        commit((s) => s.shifts.push({ id: uid('sh'), cashier: d.cashier.trim(), openedAt: new Date().toISOString(), openingCash: v }));
        toast('تم فتح الوردية', 'ok');
      });
    },
  });
}

function cashMoveDialog(type) {
  const sh = currentShift();
  const sm = shiftSummary(S, sh);
  openModal({
    title: type === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي', size: 'sm',
    body: `<div class="col">${field('المبلغ (ج.م) *', '<input class="input" name="amount" inputmode="decimal">')}${field('السبب *', '<input class="input" name="reason">')}${type === 'withdrawal' ? `<div class="hint">المتاح في الدرج حاليًا (متوقع): ${fmtMoney(sm.expected)}</div>` : ''}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-primary" data-ok>تسجيل</button>',
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const v = parseEgp(d.amount);
        if (Number.isNaN(v) || v <= 0) return markInvalid(el, 'amount', 'أدخل مبلغًا صحيحًا');
        if (!d.reason.trim()) return markInvalid(el, 'reason', 'السبب مطلوب');
        if (type === 'withdrawal' && v > sm.expected) return markInvalid(el, 'amount', 'المبلغ أكبر من النقدية المتوقعة في الدرج');
        close();
        commit((s) => s.cashMovements.push({ id: uid('cm'), shiftId: sh.id, type, amount: v, reason: d.reason.trim(), at: new Date().toISOString() }));
        toast('تم تسجيل الحركة', 'ok');
      });
    },
  });
}

function closeShiftDialog() {
  const sh = currentShift();
  const sm = shiftSummary(S, sh);
  const pending = S.orders.filter((o) => o.status === 'pending' || o.status === 'held').length;
  openModal({
    title: 'إغلاق الوردية', size: 'sm',
    body: `<div class="col"><div class="kv"><span>رصيد الافتتاح</span><span class="num">${fmtMoney(sh.openingCash)}</span></div><div class="kv"><span>+ مبيعات نقدية</span><span class="num">${fmtMoney(sm.by.cash)}</span></div><div class="kv"><span>+ إيداعات − سحوبات</span><span class="num">${fmtMoney(sm.deposits - sm.withdrawals)}</span></div><div class="kv"><span>− مرتجعات ومصروفات نقدية</span><span class="num">${fmtMoney(sm.cashRefunds + sm.cashExpenses)}</span></div><div class="kv total"><span>النقدية المتوقعة</span><span class="num">${fmtMoney(sm.expected)}</span></div>
      ${field('النقدية الفعلية المعدودة (ج.م) *', '<input class="input" name="counted" inputmode="decimal">')}<div id="diff" class="kv"><span>الفرق</span><b>—</b></div>
      ${pending ? `<div class="hint" style="color:var(--amber)">تنبيه: يوجد ${fmtInt(pending)} طلبات مفتوحة/معلّقة.</div>` : ''}${field('ملاحظات', '<input class="input" name="note">')}</div>`,
    footer: '<button class="btn" data-close>إلغاء</button><button class="btn btn-danger" data-ok>إغلاق الوردية</button>',
    onMount(el, close) {
      const inp = el.querySelector('[name=counted]');
      inp.addEventListener('input', () => { const v = parseEgp(inp.value); el.querySelector('#diff').innerHTML = Number.isNaN(v) ? '<span>الفرق</span><b>—</b>' : `<span>الفرق (معدود − متوقع)</span><b class="num ${v - sm.expected < 0 ? 'neg-num' : 'pos-num'}">${fmtMoney(v - sm.expected)}</b>`; });
      el.querySelector('[data-ok]').addEventListener('click', () => {
        clearInvalid(el);
        const d = formData(el);
        const v = parseEgp(d.counted);
        if (Number.isNaN(v) || v < 0) return markInvalid(el, 'counted', 'أدخل المبلغ المعدود');
        close();
        commit((s) => { const x = s.shifts.find((y) => y.id === sh.id); Object.assign(x, { closedAt: new Date().toISOString(), expectedCash: sm.expected, countedCash: v, difference: v - sm.expected, note: d.note.trim() }); });
        toast('تم إغلاق الوردية وحفظ التقرير', 'ok');
      });
    },
  });
}

// ===== المرتجعات =====
PAGES.refunds = {
  render() {
    const admin = can('refunds.execute');
    const RQ = UI.refunds;
    const q = RQ.q.trim().toLowerCase();
    const found = q ? S.orders.filter((o) => o.status === 'completed' && o.no.toLowerCase().includes(q)).slice(-8).reverse() : [];
    const o = RQ.orderId ? S.orders.find((x) => x.id === RQ.orderId) : null;
    const methods = S.settings.refunds.methods.map((m) => [m, METHOD_LABEL[m] || m]);
    let formHtml = '';
    if (!admin) formHtml = `<div class="card"><div class="card-b">${emptyState('تنفيذ المرتجعات متاح لمدير النظام فقط في هذه المحاكاة. الباك إند يجب أن يفرض ذلك لاحقًا.', '🔒')}</div></div>`;
    else formHtml = `<div class="card mb-14"><div class="card-h">١) البحث عن الفاتورة</div><div class="card-b"><div class="input-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input class="input" id="rq" placeholder="رقم الفاتورة مثل INV-000120" value="${esc(RQ.q)}"></div>
        <div class="row wrap mt-8">${found.map((x) => `<button class="chip ${RQ.orderId === x.id ? 'on' : ''}" data-pick="${x.id}">${esc(x.no)} — ${fmtMoney(x.total)}</button>`).join('') || (q ? '<span class="muted">لا توجد فاتورة مكتملة مطابقة</span>' : '<span class="muted">ابدأ بكتابة رقم الفاتورة</span>')}</div></div></div>
      ${o ? `<div class="card mb-14"><div class="card-h">٢) أصناف الفاتورة ${esc(o.no)} — ${dt(o.paidAt)}</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الصنف</th><th>الكمية الأصلية</th><th>مسترجع سابقًا</th><th>المتبقي</th><th>إجمالي الصنف</th><th>كمية الاسترجاع</th><th>قيمة الاسترجاع</th></tr></thead><tbody>
        ${o.items.map((i, idx) => { const left = i.qty - i.refundedQty; return `<tr><td>${i.emoji} ${esc(i.name)}</td><td class="num">${fmtInt(i.qty)}</td><td class="num">${fmtInt(i.refundedQty)}</td><td class="num">${fmtInt(left)}</td><td class="num">${fmtMoney(i.totalAlloc)}</td><td><input class="input" style="width:80px" data-rq="${idx}" type="number" min="0" max="${left}" value="0" ${left ? '' : 'disabled'}></td><td class="num" data-ra="${idx}">—</td></tr>`; }).join('')}</tbody></table></div>
        <div class="card-b"><div class="form-grid">${field('طريقة الاسترجاع', `<select class="select" id="rm">${methods.map(([k2, l]) => `<option value="${k2}" ${k2 === o.payments[0].method ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}${field(`سبب الاسترجاع ${S.settings.refunds.requireReason ? '*' : ''}`, '<input class="input" id="rr" placeholder="مثال: خطأ في الطلب">')}</div>
        <div class="kv total"><span>إجمالي قيمة الاسترجاع</span><span class="num" id="rt">${fmtMoney(0)}</span></div><div class="err-t" id="re"></div>
        <div class="hint">هذا تسجيل محاكاة فقط ولا يعني إعادة أموال فعلية لبطاقة أو محفظة. الفاتورة الأصلية لا تُحذف ولا تُعدّل بياناتها (تُسجل كميات المرتجع فقط).</div>
        <div class="row end mt-8"><button class="btn btn-danger btn-lg" id="rgo" disabled>تنفيذ الاسترجاع</button></div></div></div>` : ''}`;
    return `${pageHead('المرتجعات')}${demoNote('واجهة محاكاة: التحقق وصلاحية المدير هنا ليسا حدًا أمنيًا. يجب على الباك إند فرض الصلاحية ومنع الاسترجاع المكرر أو الزائد.')}${formHtml}
      <div class="card"><div class="card-h">سجل المرتجعات (${fmtInt(S.refunds.length)})</div>${dataTable({
        id: 'refundlog', rows: S.refunds.slice().reverse(), pageSize: 8, search: (r) => `${r.ref} ${r.orderNo} ${r.reason}`, empty: 'لا توجد مرتجعات',
        columns: [
          { label: 'المرجع', render: (r) => `<b>${esc(r.ref)}</b>` }, { label: 'الفاتورة', render: (r) => esc(r.orderNo) }, { label: 'الوقت', render: (r) => dt(r.at), sort: (r) => r.at },
          { label: 'الأصناف', render: (r) => r.items.map((i) => `${esc(i.name)} ×${fmtInt(i.qty)}`).join('، ') }, { label: 'المبلغ', render: (r) => `<span class="num neg-num">${fmtMoney(r.amount)}</span>`, sort: (r) => r.amount },
          { label: 'الطريقة', render: (r) => METHOD_LABEL[r.method] || r.method }, { label: 'السبب', render: (r) => esc(r.reason) }, { label: '', render: () => '<button class="btn btn-sm" data-act="rcpt">إيصال</button>' },
        ],
      })}</div>`;
  },
  bind(root) {
    const rq = root.querySelector('#rq');
    if (rq) rq.addEventListener('input', () => { UI.refunds.q = rq.value; UI.refunds.orderId = null; render(); const n = document.querySelector('#rq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { UI.refunds.orderId = b.dataset.pick; render(); }));
    bindTable(root, 'refundlog', (act, r) => { if (act === 'rcpt') refundReceipt(r); });
    const o = UI.refunds.orderId ? S.orders.find((x) => x.id === UI.refunds.orderId) : null;
    if (!o) return;
    const calc = () => {
      const lines = [];
      let err = '';
      let total = 0;
      root.querySelectorAll('[data-rq]').forEach((i) => {
        const idx = Number(i.dataset.rq);
        const q = Number(i.value);
        const cell = root.querySelector(`[data-ra="${idx}"]`);
        if (!q) { cell.textContent = '—'; return; }
        try { const a = refundItemAmount(o.items[idx], q); cell.textContent = fmtMoney(a); total += a; lines.push({ itemIndex: idx, qty: q }); } catch (e) { cell.textContent = '—'; err = `${o.items[idx].name}: ${e.message}`; }
      });
      root.querySelector('#rt').textContent = fmtMoney(total);
      root.querySelector('#re').textContent = err;
      root.querySelector('#rgo').disabled = !lines.length || !!err;
      return { lines, total };
    };
    root.querySelectorAll('[data-rq]').forEach((i) => i.addEventListener('input', calc));
    let busy = false;
    root.querySelector('#rgo').addEventListener('click', () => {
      const c = calc();
      if (!c.lines.length || busy) return;
      const method = root.querySelector('#rm').value;
      const reason = root.querySelector('#rr').value;
      if (S.settings.refunds.requireReason && !reason.trim()) return (root.querySelector('#re').textContent = 'سبب الاسترجاع مطلوب');
      confirmDialog({ title: 'تأكيد الاسترجاع', message: `تسجيل مرتجع بقيمة <b>${fmtMoney(c.total)}</b> على الفاتورة ${esc(o.no)} بطريقة «${METHOD_LABEL[method] || method}». هذه محاكاة ولن تُحوَّل أموال فعلية.`, confirmText: 'تأكيد وتسجيل', danger: true,
        onConfirm: () => {
          if (busy) return;
          busy = true;
          const r = createRefund({ orderId: o.id, lines: c.lines, method, reason });
          if (!r.ok) { busy = false; return toast(r.error, 'err'); }
          UI.refunds.orderId = null; UI.refunds.q = '';
          render();
          toast(`تم تسجيل المرتجع ${r.refund.ref} (محاكاة)`, 'ok');
          refundReceipt(r.refund);
        } });
    });
  },
};

function refundReceipt(r) {
  const set = S.settings;
  const html = `<div class="paper"><h3>${esc(set.business.name)}</h3><div class="c">إيصال مرتجع (تجريبي)</div><hr><div>المرجع: <b>${esc(r.ref)}</b></div><div>الفاتورة الأصلية: ${esc(r.orderNo)}</div><div>${dt(r.at)} — ${esc(r.by)}</div><hr>
    <table>${r.items.map((i) => `<tr><td>${esc(i.name)} ×${fmtInt(i.qty)}</td><td class="e">${fmtNum(i.amount)}</td></tr>`).join('')}</table><hr><table><tr class="tot"><td>إجمالي المرتجع</td><td class="e">${fmtMoney(r.amount)}</td></tr><tr><td>الطريقة</td><td class="e">${METHOD_LABEL[r.method] || r.method}</td></tr></table><div>السبب: ${esc(r.reason)}</div>
    <div class="demo-mark">— تسجيل تجريبي: لا يعني تحويل أموال فعليًا —</div></div>`;
  openModal({ title: 'إيصال المرتجع (معاينة)', size: 'sm', body: `<div class="paper-bg">${html}</div>`, footer: `<button class="btn" data-close>إغلاق</button><button class="btn btn-primary" data-print>${icon('print')} طباعة من المتصفح</button>`, onMount(el) { el.querySelector('[data-print]').addEventListener('click', () => printHtml(html)); } });
}

// ===== إعدادات الطابعات =====
function validIPv4(h) { return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h); }

PAGES.printers = {
  render() {
    const card = (p) => {
      const isR = p.role === 'receipt';
      return `<div class="card printer-card" data-printer="${p.role}"><div class="card-h"><span>${isR ? '🧾 الطابعة A — إيصالات الكاشير' : '👨‍🍳 الطابعة B — المطبخ / البار'}</span><span class="badge ${p.simulatedStatus === 'connected' ? 'b-green' : 'b-red'}"><i class="status-dot ${p.simulatedStatus === 'connected' ? 'dot-g' : 'dot-r'}"></i>${p.simulatedStatus === 'connected' ? 'متصلة (محاكاة)' : 'غير متصلة (محاكاة)'}</span></div>
        <div class="card-b"><div class="form-grid">
          ${field('اسم الطابعة *', `<input class="input" name="name" value="${esc(p.name)}">`)}
          ${field('الدور', `<input class="input" value="${isR ? 'إيصالات العملاء والمرتجعات' : 'تذاكر المطبخ/البار (بدون بيانات دفع)'}" disabled>`)}
          ${field('نوع الاتصال', `<select class="select" name="connection"><option value="usb" ${p.connection === 'usb' ? 'selected' : ''}>USB</option><option value="lan" ${p.connection === 'lan' ? 'selected' : ''}>شبكة LAN</option><option value="bluetooth" ${p.connection === 'bluetooth' ? 'selected' : ''}>Bluetooth</option></select>`)}
          <div class="field" data-dev>${'<label>اسم الجهاز *</label>'}<input class="input" name="device" value="${esc(p.device)}" placeholder="مثال: EPSON TM-T20"></div>
          <div class="field" data-lan><label>عنوان IP *</label><input class="input" name="host" value="${esc(p.host)}" placeholder="192.168.1.60" style="direction:ltr;text-align:right"></div>
          <div class="field" data-lan><label>المنفذ *</label><input class="input" name="port" value="${p.port}" inputmode="numeric"></div>
          ${field('عرض الورق', `<select class="select" name="paperWidth"><option value="58" ${p.paperWidth === 58 ? 'selected' : ''}>58 مم</option><option value="80" ${p.paperWidth === 80 ? 'selected' : ''}>80 مم</option></select>`)}
          ${field('عدد النسخ', `<input class="input" name="copies" type="number" min="1" max="5" value="${p.copies}">`)}
          <label class="check"><span class="switch"><input type="checkbox" name="autoPrint" ${p.autoPrint ? 'checked' : ''}><span></span></span> طباعة تلقائية</label>
          ${field('حالة الاتصال (محاكاة للعرض فقط)', `<select class="select" name="simulatedStatus"><option value="connected" ${p.simulatedStatus === 'connected' ? 'selected' : ''}>متصلة</option><option value="disconnected" ${p.simulatedStatus === 'disconnected' ? 'selected' : ''}>غير متصلة</option></select>`)}
        </div>
        <div class="kv mt-14"><span>آخر اختبار طباعة</span><span>${p.lastTest ? `${p.lastTest.ok ? '✅' : '❌'} ${esc(p.lastTest.message)} — ${dt(p.lastTest.at)}` : 'لم يُجرَ بعد'}</span></div>
        <div class="err-t" data-err></div>
        <div class="row mt-8"><button class="btn btn-primary" data-save>حفظ الإعدادات</button><button class="btn" data-test>${icon('print')} اختبار طباعة (محاكاة)</button><button class="btn" data-preview>${icon('eye')} معاينة ${isR ? 'الإيصال' : 'تذكرة المطبخ'}</button></div></div></div>`;
    };
    return `${pageHead('إعدادات الطابعات')}${demoNote('مرحلة الواجهة الأمامية فقط: لا توجد طباعة فعلية ولا اتصال حقيقي بأي طابعة. «متصلة» حالة عرض تجريبية لا تعني وجود جهاز. الطباعة الحرارية المباشرة عبر USB/LAN/Bluetooth ستحتاج خدمة طباعة محلية أو تطبيق سطح مكتب في مرحلة الباك إند.')}
      <div class="grid g2">${S.printers.map(card).join('')}</div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-printer]').forEach((el) => {
      const role = el.dataset.printer;
      const get = () => { const d = formData(el); return { ...d, port: Number(d.port), copies: Number(d.copies), paperWidth: Number(d.paperWidth) }; };
      const sync = () => { const c = el.querySelector('[name=connection]').value; el.querySelectorAll('[data-lan]').forEach((x) => x.classList.toggle('hidden', c !== 'lan')); el.querySelector('[data-dev]').classList.toggle('hidden', c === 'lan'); };
      el.querySelector('[name=connection]').addEventListener('change', sync); sync();
      const validate = (d) => {
        clearInvalid(el);
        let bad = false;
        if (!d.name.trim()) { markInvalid(el, 'name', 'الاسم مطلوب'); bad = true; }
        if (d.connection === 'lan') {
          if (!validIPv4(d.host.trim())) { markInvalid(el, 'host', 'عنوان IP غير صحيح'); bad = true; }
          if (!(d.port >= 1 && d.port <= 65535)) { markInvalid(el, 'port', 'منفذ بين 1 و 65535'); bad = true; }
        } else if (!d.device.trim()) { markInvalid(el, 'device', 'اسم الجهاز مطلوب'); bad = true; }
        if (!(d.copies >= 1 && d.copies <= 5)) { markInvalid(el, 'copies', 'من 1 إلى 5'); bad = true; }
        return !bad;
      };
      el.querySelector('[data-save]').addEventListener('click', () => {
        const d = get();
        if (!validate(d)) return toast('تحقق من الحقول المطلوبة', 'err');
        commit((s) => Object.assign(s.printers.find((p) => p.role === role), { name: d.name.trim(), connection: d.connection, device: d.device.trim(), host: d.host.trim(), port: d.port, paperWidth: d.paperWidth, copies: d.copies, autoPrint: d.autoPrint, simulatedStatus: d.simulatedStatus }));
        toast('تم حفظ إعدادات الطابعة (محليًا)', 'ok');
      });
      el.querySelector('[data-test]').addEventListener('click', () => {
        const d = get();
        if (!validate(d)) return toast('أكمل الإعدادات أولًا', 'err');
        const ok = d.simulatedStatus === 'connected';
        const message = ok ? 'نجح اختبار المحاكاة (لم تُرسل أي بيانات لطابعة فعلية)' : 'فشل الاختبار: الطابعة غير متصلة (محاكاة)';
        commit((s) => { const p = s.printers.find((x) => x.role === role); Object.assign(p, { simulatedStatus: d.simulatedStatus, lastTest: { at: new Date().toISOString(), ok, message } }); });
        toast(message, ok ? 'ok' : 'err');
      });
      el.querySelector('[data-preview]').addEventListener('click', () => {
        const d = get();
        const sample = S.orders.filter((o) => o.status === 'completed').slice(-1)[0];
        if (!sample) return toast('لا توجد فاتورة للمعاينة', 'err');
        const html = role === 'receipt' ? receiptHtml(sample, { paperWidth: d.paperWidth }) : kitchenTicketHtml(sample, sample.items, { paperWidth: d.paperWidth });
        openModal({ title: role === 'receipt' ? 'معاينة إيصال العميل' : 'معاينة تذكرة المطبخ/البار', size: 'sm', body: `<div class="paper-bg">${html}</div>`, footer: '<button class="btn" data-close>إغلاق</button>' });
      });
    });
  },
};

// ===== الإعدادات العامة =====
const SET_TABS = [['business', 'بيانات المنشأة'], ['notify', 'إشعارات المدير'], ['regional', 'الإعدادات الإقليمية'], ['invoice', 'الفاتورة'], ['discounts', 'الخصومات'], ['inventory', 'المخزون'], ['payments', 'المدفوعات'], ['refunds', 'المرتجعات'], ['appearance', 'المظهر'], ['uom', 'وحدات القياس']];

PAGES.settings = {
  render() {
    const t = UI.settingsTab;
    const s = S.settings;
    const edit = can('settings.edit');
    const dis = edit ? '' : 'disabled';
    let body = '';
    if (t === 'business') body = `<div class="form-grid">${field('اسم المنشأة', `<input class="input" name="name" value="${esc(s.business.name)}" ${dis}>`)}${field('الفرع', `<input class="input" name="branch" value="${esc(s.business.branch)}" ${dis}>`)}${field('العنوان', `<input class="input" name="address" value="${esc(s.business.address)}" ${dis}>`)}${field('الهاتف', `<input class="input" name="phone" value="${esc(s.business.phone)}" ${dis}>`)}${field('البريد الإلكتروني', `<input class="input" name="email" value="${esc(s.business.email)}" ${dis}>`)}${field('نوع النشاط', `<select class="select" name="mode" ${dis}><option value="cafe" ${s.business.mode === 'cafe' ? 'selected' : ''}>كافيه / مطعم</option><option value="market" ${s.business.mode === 'market' ? 'selected' : ''}>سوبر ماركت</option></select>`)}<div class="field"><label>الشعار (يُحفظ في المتصفح)</label><div class="row"><div id="logo-prev" style="width:56px;height:56px;border-radius:12px;background:var(--gray-l) center/cover;${s.business.logo ? `background-image:url('${esc(s.business.logo)}')` : ''}"></div><input type="file" name="logo" accept="image/*" ${dis}></div></div></div>`;
    else if (t === 'regional') body = `<div class="form-grid">${field('اللغة', '<input class="input" value="العربية" disabled>')}${field('اتجاه الصفحة', '<input class="input" value="من اليمين لليسار (RTL)" disabled>')}${field('العملة', '<input class="input" value="الجنيه المصري (EGP)" disabled>')}${field('صيغة التاريخ', `<select class="select" name="dateFormat" ${dis}><option value="dd/MM/yyyy" ${s.regional.dateFormat === 'dd/MM/yyyy' ? 'selected' : ''}>يوم/شهر/سنة</option><option value="yyyy-MM-dd" ${s.regional.dateFormat === 'yyyy-MM-dd' ? 'selected' : ''}>سنة-شهر-يوم</option></select>`)}${field('صيغة الوقت', `<select class="select" name="timeFormat" ${dis}><option value="12" ${s.regional.timeFormat === '12' ? 'selected' : ''}>12 ساعة</option><option value="24" ${s.regional.timeFormat === '24' ? 'selected' : ''}>24 ساعة</option></select>`)}</div><div class="hint mt-8">اللغة والاتجاه والعملة ثابتة في هذه النسخة.</div>`;
    else if (t === 'invoice') body = `<div class="form-grid">${field('بادئة رقم الفاتورة', `<input class="input" name="prefix" value="${esc(s.invoice.prefix)}" ${dis}>`)}${field('عرض الورق', `<select class="select" name="paperWidth" ${dis}><option value="58" ${s.invoice.paperWidth === 58 ? 'selected' : ''}>58 مم</option><option value="80" ${s.invoice.paperWidth === 80 ? 'selected' : ''}>80 مم</option></select>`)}${field('رأس الإيصال', `<input class="input" name="header" value="${esc(s.invoice.header)}" ${dis}>`, 'full')}${field('تذييل الإيصال', `<input class="input" name="footer" value="${esc(s.invoice.footer)}" ${dis}>`, 'full')}${field('حجم الخط (px)', `<input class="input" name="fontSize" type="number" min="9" max="18" value="${s.invoice.fontSize}" ${dis}>`)}${field('عدد النسخ', `<input class="input" name="copies" type="number" min="1" max="5" value="${s.invoice.copies}" ${dis}>`)}<label class="check"><input type="checkbox" name="autoPrint" ${s.invoice.autoPrint ? 'checked' : ''} ${dis}> طباعة تلقائية بعد البيع (محاكاة)</label></div><div class="row mt-14"><button class="btn" data-preview-receipt>${icon('eye')} معاينة الإيصال</button></div>`;
    else if (t === 'discounts') body = `<div class="form-grid"><label class="check"><input type="checkbox" name="allowPercent" ${s.discounts.allowPercent ? 'checked' : ''} ${dis}> السماح بخصم نسبة مئوية</label><label class="check"><input type="checkbox" name="allowFixed" ${s.discounts.allowFixed ? 'checked' : ''} ${dis}> السماح بخصم مبلغ ثابت</label>${field('أقصى نسبة خصم (%)', `<input class="input" name="maxPercent" inputmode="decimal" value="${s.discounts.maxPercent}" ${dis}>`)}${field('أقصى خصم ثابت (ج.م)', `<input class="input" name="maxFixed" inputmode="decimal" value="${egpToInput(s.discounts.maxFixed)}" ${dis}>`)}${field('اعتماد المدير مطلوب فوق نسبة (%)', `<input class="input" name="approve" inputmode="decimal" value="${s.discounts.requireApprovalAbovePercent}" ${dis}>`)}</div>`;
    else if (t === 'inventory') body = `<div class="form-grid">${field('الحد الأدنى الافتراضي للأصناف الجديدة (وحدة أساسية)', `<input class="input" name="defaultMinQty" inputmode="decimal" value="${s.inventory.defaultMinQty}" ${dis}>`)}${field('عند نقص المخزون وقت البيع', `<select class="select" name="insufficientStock" ${dis}><option value="allow" ${s.inventory.insufficientStock === 'allow' ? 'selected' : ''}>السماح مع تسجيل رصيد سالب</option><option value="block" ${s.inventory.insufficientStock === 'block' ? 'selected' : ''}>منع إتمام البيع</option></select>`)}<label class="check"><input type="checkbox" name="restoreOnRefund" ${s.inventory.restoreOnRefund ? 'checked' : ''} ${dis}> إعادة مكونات الأصناف المسترجعة إلى المخزون</label></div><div class="hint mt-8">وحدات القياس المدعومة: كجم/جرام/ملي جرام، لتر/مللي/أونصة سائلة (OZ)، قطعة (تحويلات ثابتة).</div>`;
    else if (t === 'payments') body = `<div class="col">${s.payments.methods.map((m, i) => `<label class="check"><input type="checkbox" data-pm="${i}" ${m.enabled ? 'checked' : ''} ${dis}> ${METHOD_ICON[m.key] || ''} ${esc(m.label)}</label>`).join('')}<label class="check" title="يتطلب نظام ائتمان عملاء في الباك إند"><input type="checkbox" disabled> السماح بالدفع الجزئي (غير متاح في العرض: يتطلب ائتمان عملاء من الباك إند)</label></div>`;
    else if (t === 'uom') body = uomTableHtml();
    else if (t === 'notify') body = `<div class="col"><label class="check"><input type="checkbox" name="enabled" ${s.notify.enabled ? 'checked' : ''} ${dis}> إرسال إشعار للمدير بإجمالي كل فاتورة مدفوعة (تيليجرام)</label>${field('توكن البوت (Bot Token)', `<input class="input" name="botToken" type="password" value="${esc(s.notify.botToken)}" ${dis} style="direction:ltr;text-align:right">`)}${field('معرّف المحادثة (Chat ID)', `<input class="input" name="chatId" value="${esc(s.notify.chatId)}" ${dis} style="direction:ltr;text-align:right">`)}<div class="hint">يحتاج إنترنت. التوكن يُحفظ في هذا المتصفح (ليس حماية حقيقية) ولا يدخل النسخ الاحتياطية. الإشعار لا يمنع البيع لو فشل ولا يُعاد إرساله تلقائيًا.</div><div class="row"><button class="btn" data-test-notify>اختبار الإرسال</button></div></div>`;
    else if (t === 'refunds') body = `<div class="col"><label class="check"><input type="checkbox" name="requireReason" ${s.refunds.requireReason ? 'checked' : ''} ${dis}> سبب الاسترجاع إلزامي</label><div class="lbl-t">طرق الاسترجاع المتاحة</div><div class="chips">${['cash', 'card', 'wallet', 'other'].map((m) => `<label class="chip check"><input type="checkbox" data-rm="${m}" ${s.refunds.methods.includes(m) ? 'checked' : ''} ${dis}> ${METHOD_LABEL[m]}</label>`).join('')}</div><div class="hint">من يستطيع تنفيذ المرتجعات يُضبط من «المستخدمون والصلاحيات» (صلاحية «تنفيذ المرتجعات»). ${SIM_SEC}</div></div>`;
    else body = `<div class="col"><div class="lbl-t">المظهر</div><div class="seg"><button data-theme="light" class="${s.appearance.theme === 'light' ? 'on' : ''}">${icon('sun')} فاتح</button><button data-theme="dark" class="${s.appearance.theme === 'dark' ? 'on' : ''}">${icon('moon')} داكن</button></div><label class="check"><input type="checkbox" name="sidebarCompact" ${s.appearance.sidebarCompact ? 'checked' : ''}> قائمة جانبية مدمجة (أيقونات فقط)</label><div class="hint">الألوان ثابتة ضمن هوية الأزرق والأبيض.</div><div class="mt-14"><button class="btn btn-danger" data-reset>إعادة ضبط بيانات العرض</button></div></div>`;
    const showSave = !['appearance', 'uom'].includes(t);
    return `${pageHead('الإعدادات العامة')}${demoNote('تُحفظ الإعدادات في هذا المتصفح فقط (تخزين تجريبي)، وليست قاعدة بيانات.')}${edit ? '' : '<div class="demo-note">ليس لديك صلاحية تعديل الإعدادات (محاكاة).</div>'}
      <div class="tabs">${SET_TABS.map(([k2, l]) => `<button class="tab ${t === k2 ? 'on' : ''}" data-stab="${k2}">${l}</button>`).join('')}</div>
      <div class="card"><div class="card-b" id="set-form">${body}<div class="err-t mt-8" id="set-err"></div>${showSave ? `<div class="row mt-14"><button class="btn btn-primary" data-save-set ${dis}>حفظ الإعدادات</button></div>` : ''}</div></div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-stab]').forEach((b) => b.addEventListener('click', () => { UI.settingsTab = b.dataset.stab; render(); }));
    const form = root.querySelector('#set-form');
    const t = UI.settingsTab;
    let logo = S.settings.business.logo || '';
    const lf = form.querySelector('[name=logo]');
    if (lf) lf.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) compressImage(f, (u) => { logo = u; form.querySelector('#logo-prev').style.backgroundImage = `url('${u}')`; }); });
    const pr = form.querySelector('[data-preview-receipt]');
    if (pr) pr.addEventListener('click', () => { const d = formData(form); const sample = S.orders.filter((o) => o.status === 'completed').slice(-1)[0]; if (!sample) return toast('لا توجد فاتورة للمعاينة', 'err'); const html = receiptHtml(sample, { paperWidth: Number(d.paperWidth) }); openModal({ title: 'معاينة الإيصال', size: 'sm', body: `<div class="paper-bg">${html}</div>`, footer: '<button class="btn" data-close>إغلاق</button>' }); });
    form.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => { commit((s) => { s.settings.appearance.theme = b.dataset.theme; }); applyTheme(); }));
    const sc = form.querySelector('[name=sidebarCompact]');
    if (sc) sc.addEventListener('change', () => commit((s) => { s.settings.appearance.sidebarCompact = sc.checked; }));
    const rs = form.querySelector('[data-reset]');
    if (rs) rs.addEventListener('click', confirmReset);
    const ua = form.querySelector('[data-uom-add]');
    if (ua) ua.addEventListener('click', () => openUomForm(null));
    form.querySelectorAll('[data-uom-edit]').forEach((b) => b.addEventListener('click', () => openUomForm(S.uoms.find((x) => x.id === b.dataset.uomEdit))));
    const tn = form.querySelector('[data-test-notify]');
    if (tn) tn.addEventListener('click', () => { const d = formData(form); sendTelegram(d.botToken, d.chatId, 'رسالة اختبار من كوفي').then(() => toast('تم إرسال رسالة الاختبار', 'ok')).catch(() => toast('فشل الإرسال — راجع التوكن ومعرّف المحادثة والإنترنت', 'err')); });
    const save = form.querySelector('[data-save-set]');
    if (!save) return;
    save.addEventListener('click', () => {
      clearInvalid(form);
      const d = formData(form);
      const err = (m, f) => { if (f) markInvalid(form, f, m); form.querySelector('#set-err').textContent = m; };
      form.querySelector('#set-err').textContent = '';
      const num = (v) => Number(String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
      let apply;
      if (t === 'business') {
        if (!d.name.trim()) return err('اسم المنشأة مطلوب', 'name');
        if (d.email.trim() && !/^\S+@\S+\.\S+$/.test(d.email.trim())) return err('بريد غير صحيح', 'email');
        apply = (s) => { s.settings.business = { name: d.name.trim(), branch: d.branch.trim(), address: d.address.trim(), phone: d.phone.trim(), email: d.email.trim(), logo, mode: d.mode || 'cafe' }; };
      } else if (t === 'regional') apply = (s) => { s.settings.regional = { dateFormat: d.dateFormat, timeFormat: d.timeFormat }; };
      else if (t === 'invoice') {
        const fs = Number(d.fontSize); const cp = Number(d.copies);
        if (!d.prefix.trim()) return err('بادئة الفاتورة مطلوبة', 'prefix');
        if (!(fs >= 9 && fs <= 18)) return err('حجم الخط بين 9 و18', 'fontSize');
        if (!(cp >= 1 && cp <= 5)) return err('عدد النسخ من 1 إلى 5', 'copies');
        apply = (s) => { s.settings.invoice = { prefix: d.prefix.trim(), header: d.header, footer: d.footer, paperWidth: Number(d.paperWidth), fontSize: fs, copies: cp, autoPrint: d.autoPrint }; };
      } else if (t === 'discounts') {
        const mp = num(d.maxPercent); const mf = parseEgp(d.maxFixed); const ap = num(d.approve);
        if (!(mp >= 0 && mp <= 100)) return err('أقصى نسبة بين 0 و100', 'maxPercent');
        if (Number.isNaN(mf) || mf < 0) return err('أقصى خصم ثابت غير صحيح', 'maxFixed');
        if (!(ap >= 0 && ap <= mp)) return err('حد الاعتماد يجب ألا يتجاوز أقصى نسبة', 'approve');
        apply = (s) => { s.settings.discounts = { allowPercent: d.allowPercent, allowFixed: d.allowFixed, maxPercent: mp, maxFixed: mf, requireApprovalAbovePercent: ap }; };
      } else if (t === 'inventory') {
        const mq = num(d.defaultMinQty);
        if (!(mq >= 0)) return err('قيمة غير صحيحة', 'defaultMinQty');
        apply = (s) => { s.settings.inventory = { defaultMinQty: mq, insufficientStock: d.insufficientStock, restoreOnRefund: d.restoreOnRefund }; };
      } else if (t === 'payments') {
        const on = [...form.querySelectorAll('[data-pm]')].map((c) => c.checked);
        if (!on.some(Boolean)) return err('فعّل طريقة دفع واحدة على الأقل');
        apply = (s) => { s.settings.payments.methods.forEach((m, i) => { m.enabled = on[i]; }); };
      } else if (t === 'notify') {
        if (d.enabled && !/^\d+:[\w-]+$/.test(d.botToken.trim())) return err('توكن البوت غير صحيح', 'botToken');
        if (d.enabled && !/^-?\d+$/.test(d.chatId.trim())) return err('معرّف المحادثة أرقام فقط', 'chatId');
        apply = (s) => { s.settings.notify = { enabled: d.enabled, botToken: d.botToken.trim(), chatId: d.chatId.trim() }; };
      } else if (t === 'refunds') {
        const ms = [...form.querySelectorAll('[data-rm]')].filter((c) => c.checked).map((c) => c.dataset.rm);
        if (!ms.length) return err('اختر طريقة استرجاع واحدة على الأقل');
        apply = (s) => { s.settings.refunds = { requireReason: d.requireReason, methods: ms }; };
      }
      commit(apply);
      applyTheme();
      render();
      toast('تم حفظ الإعدادات (محليًا في المتصفح)', 'ok');
    });
  },
};


// ===== الضريبة: شاشة مستقلة =====
function taxExample(tx, priceEgp) {
  const price = Math.round(priceEgp * 100);
  const r = priceCart([{ basePrice: price, options: [], qty: 1, taxExempt: false }], { type: null, value: 0 }, { tax: tx });
  return r.t || r;
}

PAGES.tax = {
  render() {
    const edit = can('settings.edit');
    const dis = edit ? '' : 'disabled';
    return `${pageHead('إعدادات الضريبة')}${demoNote('الضريبة هنا تجريبية للعرض، وتُحفظ في هذا المتصفح فقط. لا تمثل إقرارًا ضريبيًا حقيقيًا.')}
      ${edit ? '' : '<div class="demo-note">ليس لديك صلاحية تعديل الإعدادات (محاكاة).</div>'}
      <div class="grid-2">
        <div class="card"><div class="card-h"><h3>الضريبة</h3></div><div class="card-b" id="tax-form">
          <div class="form-grid"><label class="check"><input type="checkbox" name="enabled" ${S.settings.tax.enabled ? 'checked' : ''} ${dis}> تفعيل الضريبة</label><span></span>
          ${field('نسبة الضريبة (%)', `<input class="input" name="ratePct" inputmode="decimal" value="${S.settings.tax.ratePct}" ${dis}>`)}
          ${field('نمط الأسعار', `<select class="select" name="mode" ${dis}><option value="exclusive" ${S.settings.tax.mode === 'exclusive' ? 'selected' : ''}>الضريبة تُضاف فوق السعر</option><option value="inclusive" ${S.settings.tax.mode === 'inclusive' ? 'selected' : ''}>السعر شامل الضريبة</option></select>`)}
          ${field('التقريب', `<select class="select" name="rounding" ${dis}><option value="half_up" ${S.settings.tax.rounding === 'half_up' ? 'selected' : ''}>لأقرب قرش (نصف لأعلى)</option><option value="up" ${S.settings.tax.rounding === 'up' ? 'selected' : ''}>لأعلى</option><option value="down" ${S.settings.tax.rounding === 'down' ? 'selected' : ''}>لأسفل</option></select>`)}</div>
          <div class="hint mt-8">الترتيب: الخصم أولًا ثم الضريبة على الصافي بعد الخصم لكل سطر. التغيير يسري على الفواتير الجديدة فقط، والقديمة تحتفظ بلقطتها.</div>
          <div class="err-t mt-8" id="tax-err"></div>
          <div class="row mt-14"><button class="btn btn-primary" data-save-tax ${dis}>حفظ إعدادات الضريبة</button></div>
        </div></div>
        <div class="card"><div class="card-h"><h3>مثال حي</h3></div><div class="card-b" id="tax-ex"></div></div>
      </div>`;
  },
  bind(root) {
    const form = root.querySelector('#tax-form');
    const ex = root.querySelector('#tax-ex');
    const num = (v) => Number(String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace('٫', '.'));
    const read = () => { const d = formData(form); return { d, r: num(d.ratePct) }; };
    const draw = () => {
      const { d, r } = read();
      if (!(r >= 0 && r <= 100)) { ex.innerHTML = '<div class="muted">أدخل نسبة صحيحة لعرض المثال</div>'; return; }
      const t = taxExample({ enabled: d.enabled, ratePct: r, mode: d.mode, rounding: d.rounding }, 100);
      ex.innerHTML = `<div class="muted xs">منتج سعره 100.00 ج.م</div>
        <div class="kv"><span>السعر بدون ضريبة</span><span class="num">${fmtMoney(t.total - t.taxAmount)}</span></div>
        <div class="kv"><span>الضريبة</span><span class="num">${fmtMoney(t.taxAmount)}</span></div>
        <div class="kv total"><span>إجمالي الفاتورة</span><b class="num">${fmtMoney(t.total)}</b></div>`;
    };
    form.addEventListener('input', draw); form.addEventListener('change', draw); draw();
    const save = form.querySelector('[data-save-tax]');
    save.addEventListener('click', () => {
      clearInvalid(form);
      const { d, r } = read();
      if (!(r >= 0 && r <= 100)) { markInvalid(form, 'ratePct', 'نسبة الضريبة بين 0 و100'); root.querySelector('#tax-err').textContent = 'نسبة الضريبة بين 0 و100'; return; }
      commit((st) => { st.settings.tax = { enabled: d.enabled, ratePct: r, mode: d.mode, rounding: d.rounding }; });
      toast('تم حفظ إعدادات الضريبة (محليًا في المتصفح)', 'ok');
    });
  },
};

function confirmReset() {
  confirmDialog({ title: 'إعادة ضبط بيانات العرض', message: 'سيتم حذف كل التعديلات المحفوظة في هذا المتصفح (طلبات، مخزون، إعدادات…) والعودة لبيانات العرض الأصلية. لا يمكن التراجع.', confirmText: 'إعادة الضبط', danger: true, onConfirm: () => { resetDemo(); UI.cashier.draft = null; toast('تمت إعادة ضبط بيانات العرض', 'ok'); render(); } });
}

// ===== الحضور والغياب =====
const ATT_LABEL = { present: 'حاضر', absent: 'غائب', leave: 'إجازة' };
const ATT_KIND = { present: 'green', absent: 'red', leave: 'amber' };
function attRec(userId, date) { return S.attendance.find((r) => r.userId === userId && r.date === date) || null; }
function attHours(r) { return r && r.inAt && r.outAt ? (new Date(r.outAt) - new Date(r.inAt)) / 3600000 : 0; }
function attAct(userId, kind) {
  const me = currentUser();
  const mgr = can('attendance.manage');
  if (userId !== me.id && !mgr) return toast('غير مصرّح', 'err');
  if ((kind === 'absent' || kind === 'leave') && !mgr) return toast('غير مصرّح', 'err');
  const date = dayKey(new Date());
  const now = new Date().toISOString();
  const cur = attRec(userId, date);
  if (kind === 'in' && cur && cur.status === 'present' && cur.inAt) return toast(cur.outAt ? 'سبق تسجيل حضور وانصراف اليوم' : 'الحضور مسجّل بالفعل', 'warn');
  if (kind === 'out' && !(cur && cur.status === 'present' && cur.inAt && !cur.outAt)) return toast('لا يوجد حضور مفتوح لتسجيل الانصراف', 'err');
  commit((s) => {
    let r = s.attendance.find((x) => x.userId === userId && x.date === date);
    if (!r) { r = { id: uid('at'), userId, date, status: 'present', inAt: null, outAt: null, by: me.name }; s.attendance.push(r); }
    if (kind === 'in') { r.status = 'present'; r.inAt = now; r.outAt = null; }
    else if (kind === 'out') r.outAt = now;
    else { r.status = kind; r.inAt = null; r.outAt = null; }
    r.by = me.name;
  });
  toast(kind === 'in' ? 'تم تسجيل الحضور' : kind === 'out' ? 'تم تسجيل الانصراف' : `تم التسجيل: ${ATT_LABEL[kind]}`, 'ok');
}

PAGES.attendance = {
  render() {
    const me = currentUser();
    const mgr = can('attendance.manage');
    const today = dayKey(new Date());
    const mine = attRec(me.id, today);
    const isOpen = !!(mine && mine.status === 'present' && mine.inAt && !mine.outAt);
    const users = S.users.filter((u) => u.active && (mgr || u.id === me.id));
    const month = UI.attMonth || today.slice(0, 7);
    const hrs = (h) => (h ? fmtQty(Math.round(h * 100) / 100) : '—');
    const roleOf = (u) => (S.roles.find((x) => x.id === u.roleId) || {}).label || '';
    const todayRows = users.map((u) => {
      const r = attRec(u.id, today);
      const acts = `<div class="actions"><button class="btn btn-sm btn-success" data-att="${u.id}|in">حضور</button><button class="btn btn-sm" data-att="${u.id}|out">انصراف</button>${mgr ? `<button class="btn btn-sm btn-danger" data-att="${u.id}|absent">غياب</button><button class="btn btn-sm" data-att="${u.id}|leave">إجازة</button>` : ''}</div>`;
      return `<tr><td><b>${esc(u.name)}</b></td><td>${esc(roleOf(u))}</td><td>${r ? badge(ATT_LABEL[r.status], ATT_KIND[r.status]) : badge('لم يُسجَّل', 'gray')}</td><td>${r && r.inAt ? tOnly(r.inAt) : '—'}</td><td>${r && r.outAt ? tOnly(r.outAt) : '—'}</td><td class="num">${hrs(attHours(r))}</td><td>${acts}</td></tr>`;
    }).join('');
    const recs = S.attendance.filter((r) => r.date.startsWith(month) && users.some((u) => u.id === r.userId));
    const summary = users.map((u) => {
      const rs = recs.filter((r) => r.userId === u.id);
      const present = rs.filter((r) => r.status === 'present' && r.inAt);
      const missing = present.filter((r) => !r.outAt && r.date < today).length;
      return `<tr><td><b>${esc(u.name)}</b></td><td class="num">${fmtInt(present.length)}</td><td class="num ${rs.some((r) => r.status === 'absent') ? 'neg-num' : ''}">${fmtInt(rs.filter((r) => r.status === 'absent').length)}</td><td class="num">${fmtInt(rs.filter((r) => r.status === 'leave').length)}</td><td class="num">${hrs(sum(rs, attHours))}</td><td class="num ${missing ? 'neg-num' : ''}">${fmtInt(missing)}</td></tr>`;
    }).join('');
    const log = recs.slice().sort((a, b) => b.date.localeCompare(a.date)).map((r) => {
      const u = S.users.find((x) => x.id === r.userId);
      return `<tr><td>${dOnly(r.date + 'T12:00:00')}</td><td>${esc(u ? u.name : '—')}</td><td>${badge(ATT_LABEL[r.status], ATT_KIND[r.status])}</td><td>${r.inAt ? tOnly(r.inAt) : '—'}</td><td>${r.outAt ? tOnly(r.outAt) : (r.inAt ? badge('بدون انصراف', 'amber') : '—')}</td><td class="num">${hrs(attHours(r))}</td></tr>`;
    }).join('');
    const selfBtn = !mine || !mine.inAt || mine.status !== 'present'
      ? `<button class="btn btn-success btn-lg" data-att="${me.id}|in">تسجيل حضوري</button>`
      : isOpen ? `<button class="btn btn-danger btn-lg" data-att="${me.id}|out">تسجيل انصرافي</button>` : badge('تم تسجيل حضورك وانصرافك اليوم', 'green');
    return `${pageHead('الحضور والغياب', selfBtn)}${demoNote('الحضور يُسجَّل من المتصفح بحساب كل موظف، ولا يوجد تحقق بالبصمة أو الموقع. اليوم الذي لا يُسجَّل فيه شيء لا يُحسب غيابًا تلقائيًا؛ يُسجَّل الغياب والإجازة من المدير.')}
      <div class="card mb-14"><div class="card-h">اليوم — ${dOnly(new Date().toISOString())}</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الموظف</th><th>الدور</th><th>الحالة</th><th>الحضور</th><th>الانصراف</th><th>الساعات</th><th></th></tr></thead><tbody>${todayRows}</tbody></table></div></div>
      <div class="row wrap mb-8"><b>الشهر:</b><input class="input" type="month" style="width:auto" data-month value="${month}"></div>
      <div class="card mb-14"><div class="card-h">ملخص الشهر</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الموظف</th><th>أيام الحضور</th><th>أيام الغياب</th><th>الإجازات</th><th>إجمالي الساعات</th><th>حضور بدون انصراف</th></tr></thead><tbody>${summary}</tbody></table></div></div>
      <div class="card"><div class="card-h">سجل الشهر</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>التاريخ</th><th>الموظف</th><th>الحالة</th><th>الحضور</th><th>الانصراف</th><th>الساعات</th></tr></thead><tbody>${log || `<tr><td colspan="6">${emptyState('لا توجد سجلات في هذا الشهر')}</td></tr>`}</tbody></table></div></div>`;
  },
  bind(root) {
    root.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', () => { const [id, k] = b.dataset.att.split('|'); attAct(id, k); }));
    const m = root.querySelector('[data-month]');
    if (m) m.addEventListener('change', () => { UI.attMonth = m.value; render(); });
  },
};

// ===== النسخ الاحتياطي والاستعادة =====
function backupPayload() {
  const copy = clone(S);
  delete copy.auth;
  if (copy.settings && copy.settings.notify) copy.settings.notify.botToken = ''; // لا يُصدَّر التوكن في النسخة الاحتياطية
  return { app: 'hyper-one-pos-demo', kind: 'DEMO_EXPORT', version: STATE_VERSION, createdAt: new Date().toISOString(), note: 'نسخة تجريبية من بيانات العرض فقط — ليست نسخة قاعدة بيانات إنتاجية.', data: copy };
}

function validateBackup(obj) {
  const errs = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errs: ['الملف ليس JSON صحيحًا'] };
  if (obj.app !== 'hyper-one-pos-demo') errs.push('الملف ليس نسخة كوفي التجريبية');
  if (obj.version !== STATE_VERSION) errs.push(`إصدار غير متوافق (${obj.version})`);
  const d = obj.data;
  if (!d || typeof d !== 'object') return { ok: false, errs: [...errs, 'لا توجد بيانات'] };
  ['categories', 'products', 'inventory', 'orders', 'refunds', 'suppliers', 'purchases', 'expenses', 'customers', 'roles', 'users', 'shifts', 'cashMovements', 'printers', 'tables', 'movements'].forEach((k) => { if (!Array.isArray(d[k])) errs.push(`الحقل ${k} مفقود أو غير صحيح`); });
  if (!d.settings || typeof d.settings !== 'object' || !d.settings.tax || !d.settings.invoice || !d.settings.payments) errs.push('الإعدادات غير مكتملة');
  if (!d.recipes || typeof d.recipes !== 'object' || Array.isArray(d.recipes)) errs.push('الوصفات غير صحيحة');
  if (!d.counters || typeof d.counters.order !== 'number') errs.push('العدادات غير صحيحة');
  if (!errs.length) {
    if (d.orders.some((o) => !o || typeof o.total !== 'number' || !Array.isArray(o.items))) errs.push('بعض الطلبات بصيغة غير صحيحة');
    if (d.products.some((p) => !p || typeof p.price !== 'number' || !p.id)) errs.push('بعض الأصناف بصيغة غير صحيحة');
    if (!d.users.some((u) => u.roleId === 'r_admin' && u.active)) errs.push('لا يوجد مستخدم مدير نشط');
  }
  return { ok: !errs.length, errs };
}

let pendingRestore = null;
PAGES.backup = {
  render() {
    const pr = pendingRestore;
    return `${pageHead('النسخ الاحتياطي والاستعادة')}${demoNote('واجهة جاهزة لربط الباك إند لاحقًا. الآن تُنشئ وتستعيد «نسخة تجريبية JSON» من بيانات العرض فقط، ولا توجد نسخة قاعدة بيانات إنتاجية.')}
      <div class="grid g2">
        <div class="card"><div class="card-h">إنشاء نسخة احتياطية (تجريبية)</div><div class="card-b"><p class="muted">تنزيل ملف JSON بكل بيانات العرض الحالية (تشمل الفاتورة المفتوحة وبدون الجلسة).</p><button class="btn btn-primary" data-create>${icon('download')} إنشاء وتنزيل النسخة</button></div></div>
        <div class="card"><div class="card-h">استعادة نسخة</div><div class="card-b"><div class="filebox"><input type="file" accept="application/json,.json" id="bf"><div class="hint mt-8">يتم فحص الملف قبل أي تغيير.</div></div>
          ${pr ? `<div class="mt-14"><div class="kv"><span>الملف</span><b>${esc(pr.name)}</b></div><div class="kv"><span>حالة الفحص</span>${pr.v.ok ? badge('صالح', 'green') : badge('غير صالح', 'red')}</div>${pr.v.ok ? `<div class="kv"><span>المحتوى</span><span class="num">${fmtInt(pr.obj.data.orders.length)} طلب • ${fmtInt(pr.obj.data.products.length)} صنف • ${fmtInt(pr.obj.data.inventory.length)} مخزون</span></div><div class="kv"><span>تاريخ النسخة</span><span>${dt(pr.obj.createdAt)}</span></div><div class="row end mt-8"><button class="btn btn-danger" data-restore>استعادة (استبدال البيانات الحالية)</button></div>` : `<ul class="err-t" style="padding-inline-start:18px">${pr.v.errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}</div>` : ''}</div></div>
      </div>
      <div class="card mt-14"><div class="card-h">سجل العمليات (تجريبي)</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>${S.backupLog.slice().reverse().map((l) => `<tr><td>${dt(l.at)}</td><td>${badge(l.kind === 'export' ? 'تصدير' : 'استعادة', l.kind === 'export' ? 'blue' : 'amber')}</td><td>${esc(l.detail)}</td></tr>`).join('') || `<tr><td colspan="3">${emptyState('لا توجد عمليات بعد')}</td></tr>`}</tbody></table></div></div>
      <div class="card mt-14"><div class="card-b row between"><div><b>إعادة ضبط بيانات العرض</b><div class="muted sm">العودة لبيانات العرض الأصلية.</div></div><button class="btn btn-danger" data-reset>إعادة الضبط</button></div></div>`;
  },
  bind(root) {
    root.querySelector('[data-create]').addEventListener('click', () => {
      const payload = backupPayload();
      const text = JSON.stringify(payload);
      downloadFile(`hyper-one-demo-backup-${dayKey(new Date())}.json`, text, 'application/json');
      commit((s) => s.backupLog.push({ at: new Date().toISOString(), kind: 'export', detail: `نسخة تجريبية ${fmtInt(Math.round(text.length / 1024))} ك.ب — ${fmtInt(payload.data.orders.length)} طلب` }));
      toast('تم إنشاء النسخة التجريبية وتنزيلها', 'ok');
    });
    root.querySelector('#bf').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        let obj = null;
        try { obj = JSON.parse(String(rd.result).replace(/^\uFEFF/, '')); } catch (er) { /* غير صالح */ }
        pendingRestore = { name: f.name, obj, v: validateBackup(obj) };
        render();
      };
      rd.onerror = () => toast('تعذر قراءة الملف', 'err');
      rd.readAsText(f);
    });
    const rb = root.querySelector('[data-restore]');
    if (rb) rb.addEventListener('click', () => confirmDialog({ title: 'تأكيد الاستعادة', message: 'سيتم استبدال كل بيانات العرض الحالية بمحتوى الملف. هذه العملية لا يمكن التراجع عنها إلا بنسخة سابقة. متابعة؟', confirmText: 'استعادة', danger: true,
      onConfirm: () => {
        const p = pendingRestore;
        if (!p || !p.v.ok) return;
        const next = clone(p.obj.data);
        next.auth = { userId: S.auth.userId };
        migrateState(next);
        next.cart = next.cart && Array.isArray(next.cart.items) ? next.cart : emptyCart();
        next.backupLog = [...(next.backupLog || []), { at: new Date().toISOString(), kind: 'restore', detail: `من الملف ${p.name}` }];
        const prev = S;
        const before = JSON.stringify(backupPayload());
        downloadFile(`hyper-one-before-restore-${dayKey(new Date())}.json`, before, 'application/json'); // نسخة من الحالة الحالية قبل الاستبدال
        try { window.localStorage.setItem('hyperone.prerestore', before); } catch (e) { /* ignore */ }
        S = next;
        if (!currentUser()) S.auth.userId = null;
        if (!persistNow()) {
          S = prev;
          render();
          return toast('فشل حفظ الاستعادة — لم تتغير بياناتك الحالية', 'err');
        }
        pendingRestore = null;
        UI.cashier.draft = null;
        applyTheme();
        render();
        audit('استعادة نسخة', `من الملف ${p.name}`);
        toast('تمت الاستعادة بنجاح (نُزّلت نسخة من الحالة السابقة)', 'ok');
      } }));
    const rs = root.querySelector('[data-reset]');
    if (rs) rs.addEventListener('click', confirmReset);
  },
};

// ===== 99-main.js =====
// ---------------------------------------------------------------------------
// نقطة البدء
// ---------------------------------------------------------------------------
function checkSaleJournal() {
  let j = null;
  try { j = JSON.parse(window.localStorage.getItem(JOURNAL_KEY) || 'null'); } catch (e) { /* ignore */ }
  if (!j) return;
  try { window.localStorage.removeItem(JOURNAL_KEY); } catch (e) { /* ignore */ }
  const done = S.orders.some((o) => o.status === 'completed' && o.paidAt && o.paidAt >= j.at);
  audit('عملية غير مكتملة', done ? 'إغلاق أثناء بيع — البيع محفوظ' : 'إغلاق أثناء بيع — لم يُحفظ');
  openModal({
    title: 'تنبيه: عملية بيع لم تكتمل', size: 'sm',
    body: `<p>${done ? `أُغلق النظام وقت إتمام بيع بتاريخ ${dt(j.at)} والفاتورة تبدو محفوظة. راجع آخر فاتورة في «الطلبات» للتأكد.` : `أُغلق النظام وقت إتمام بيع بتاريخ ${dt(j.at)} ولم تُحفظ الفاتورة ولم يُخصم المخزون. السلة (إن وُجدت) محفوظة في الكاشير ويمكنك إعادة البيع.`}</p><div class="hint">لم يُعد النظام تنفيذ أي عملية تلقائيًا لتجنب تكرار الفاتورة.</div>`,
    footer: '<button class="btn" data-close>حسنًا</button>',
  });
}

function startIdbCheck() {
  idbGet('state').then((raw) => {
    let valid = null;
    try { const p = raw && JSON.parse(raw); if (p && p.v === STATE_VERSION && Array.isArray(p.orders) && p.settings) valid = raw; } catch (e) { /* ignore */ }
    if (valid && (FRESH_BOOT || RECOVERY)) { RECOVERY = RECOVERY || { raw: '' }; RECOVERY.idb = valid; render(); }
    idbReady = !RECOVERY;
    if (idbReady) idbMirrorSoon();
  }).catch(() => { idbReady = !RECOVERY; });
}

function boot() {
  initState();
  window.addEventListener('beforeunload', persistNow);
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY || !isMenuRoute() || !e.newValue) return;
    try { const p = JSON.parse(e.newValue); if (p && p.v === STATE_VERSION) { S = p; applyTheme(); render(); } } catch (er) { /* ignore */ }
  });
  render();
  checkSaleJournal();
  startIdbCheck();
  window.__HOP = { get state() { return S; }, render, go, createRefund, can, login, logout, toBase, validateConvs, decimalsOk, compatibleUnits, uoms: () => UOM };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
