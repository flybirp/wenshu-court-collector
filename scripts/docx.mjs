// 极简 OOXML(.docx) 生成器 —— 纯 Node 实现，无第三方依赖
import zlib from 'node:zlib';

function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) >>> 0 : crc32Fallback(buf) >>> 0;
}

function crc32Fallback(buf) {
  let table = crc32Fallback.table;
  if (!table) {
    table = crc32Fallback.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function zip(entries) {
  // entries: [{name, data(Buffer)}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2100, 12); // date (2016-01-01 附近，占位)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x2100, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function para(text, opts = {}) {
  const { bold = false, size = 24, center = false, indent = true } = opts;
  const rpr = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋_GB2312"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const ppr = `<w:pPr><w:spacing w:line="360" w:lineRule="auto"/>${center ? '<w:jc w:val="center"/>' : ''}${indent && !center ? '<w:ind w:firstLine="480"/>' : ''}</w:pPr>`;
  const lines = String(text ?? '').split('\n');
  const runs = lines
    .map(
      (ln, i) =>
        `<w:r>${rpr}<w:t xml:space="preserve">${esc(ln)}${i < lines.length - 1 ? '<w:br/>' : ''}</w:t></w:r>`
    )
    .join('');
  return `<w:p>${ppr}${runs}</w:p>`;
}

/**
 * 生成裁判文书 .docx
 * @param {object} doc {title, meta:[{k,v}], paragraphs:[string], source}
 * @returns {Buffer}
 */
export function buildDocx({ title = '裁判文书', meta = [], paragraphs = [], source = '' }) {
  const body = [];
  body.push(para(title, { bold: true, size: 36, center: true, indent: false }));
  body.push(para('', { size: 24, indent: false }));
  if (meta.length) {
    for (const m of meta) {
      if (m && m.v) body.push(para(`${m.k ? m.k + '：' : ''}${m.v}`, { size: 21, indent: false }));
    }
    body.push(para('', { size: 21, indent: false }));
  }
  for (const p of paragraphs) body.push(para(p));
  if (source) {
    body.push(para('', { indent: false }));
    body.push(para(source, { size: 18, indent: false }));
  }
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    body.join('') +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

/** 把详情接口返回的 qwContent(HTML片段) 转成段落数组 */
export function htmlToParagraphs(html) {
  if (!html) return [];
  let s = String(html)
    .replace(/<\s*(br|BR)\s*\/?>/g, '\n')
    .replace(/<\s*\/\s*(p|P|div|DIV|tr|TR|h[1-6]|li)\s*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u3000]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
