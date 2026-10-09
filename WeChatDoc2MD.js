// ==UserScript==
// @name         企业微信智能文档导出 Markdown
// @namespace    local.weixin.smartpage.export
// @version      1.0.1
// @author       wlianmin
// @description  使用当前登录态读取完整智能文档，并下载为 Markdown 文件
// @homepageURL  https://github.com/wlianmin/WeChatDoc2MD
// @source       https://github.com/wlianmin/WeChatDoc2MD/blob/main/WeChatDoc2MD.js
// @supportURL   https://github.com/wlianmin/WeChatDoc2MD/issues
// @downloadURL  https://raw.githubusercontent.com/wlianmin/WeChatDoc2MD/main/WeChatDoc2MD.js
// @updateURL    https://raw.githubusercontent.com/wlianmin/WeChatDoc2MD/main/WeChatDoc2MD.js
// @license      MIT
// @match        https://page.weixin.qq.com/smartpage/p/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const TYPE = {
    TEXT: 1,
    PAGE: 5,
    ORDERED_LIST: 7,
    BULLETED_LIST: 8,
    DIVIDER: 9,
    HEADER_1: 12,
    HEADER_2: 13,
    HEADER_3: 14,
    TABLE: 26,
    TABLE_ROW: 27,
    TABLE_CELL: 28,
    QUOTE: 30,
  };

  const state = { exporting: false };

  function findXsrf() {
    const cookie = document.cookie.match(/(?:^|;\s*)TOK=([^;]*)/);
    if (cookie) return decodeURIComponent(cookie[1]);

    const request = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/smartcanvasread/opendoc?'));
    return request ? new URL(request).searchParams.get('xsrf') || '' : '';
  }

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);

    const data = await response.json();
    if (data.head && data.head.ret !== 0) {
      throw new Error(data.head.msg || `接口返回错误：${data.head.ret}`);
    }
    return data;
  }

  async function loadDocument(updateStatus) {
    const publishCode = location.pathname.split('/').filter(Boolean).pop();
    const pageId = new URLSearchParams(location.search).get('p');
    const xsrf = findXsrf();
    if (!publishCode || !pageId) throw new Error('当前地址缺少文档或页面标识');

    updateStatus('正在读取文档...');
    const opened = await postJson(
      `/smartcanvasread/opendoc?xsrf=${encodeURIComponent(xsrf)}`,
      {
        publish_code: publishCode,
        chunked: 1,
        view: 1,
        limit: 500,
        scode: '',
        page_id: pageId,
        kanban_page_id: pageId,
      },
    );

    const body = opened.body || {};
    const padId = body.client_vars && body.client_vars.doc_info && body.client_vars.doc_info.pad_id;
    if (!padId) throw new Error('未取得文档标识，请确认已扫码登录且有查看权限');

    const blocks = [...(body.top_blocks || []), ...(body.cur_blocks || [])];
    let cursor = body.cursor;
    let page = 1;

    while (cursor && cursor.has_more) {
      updateStatus(`正在读取第 ${++page} 批内容...`);
      const result = await postJson(
        `/smartcanvasread/get_block_by_cursor?xsrf=${encodeURIComponent(xsrf)}`,
        {
          pad_id: padId,
          page_id: pageId,
          limit: 500,
          cursor,
          req_tag: Math.random().toString(36).slice(2, 8),
          req_ts: Date.now(),
        },
      );
      const next = result.body || {};
      blocks.push(...(next.blocks || next.cur_blocks || []));
      cursor = next.cursor;
      if (page > 100) throw new Error('分页数量异常，已停止导出');
    }

    return {
      blocks,
      pageId,
      title: body.client_vars.doc_info.name || document.title || '企业微信文档',
      apool: body.apool || '',
    };
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200c|\u200d|\ufeff/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function normalizeInlineText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200c|\u200d|\ufeff/g, '')
      .replace(/\r\n?/g, '\n');
  }

  function escapeInline(text) {
    return normalizeInlineText(text).replace(/([\\`*_<>])/g, '\\$1');
  }

  function escapeTableCell(text) {
    return normalizeText(text).replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
  }

  function blockText(block) {
    return normalizeText(block && block.props && block.props.title && block.props.title.text);
  }

  function parseAttributePool(apool) {
    if (!apool) return new Map();
    try {
      const parsed = typeof apool === 'string' ? JSON.parse(apool) : apool;
      const pool = new Map();
      Object.entries(parsed.numToAttrib || {}).forEach(([id, pair]) => {
        if (!Array.isArray(pair)) return;
        let value = pair[1];
        try { value = JSON.parse(value); } catch (_) { /* keep plain value */ }
        pool.set(Number(id), { key: pair[0], value });
      });
      return pool;
    } catch (_) {
      return new Map();
    }
  }

  function decodeAttributeRuns(attribs, textLength) {
    const runs = [];
    let cursor = 0;
    let index = 0;
    while (index < String(attribs || '').length) {
      const attributes = [];
      while (attribs[index] === '*') {
        index += 1;
        const start = index;
        while (index < attribs.length && /[0-9a-z]/i.test(attribs[index])) index += 1;
        attributes.push(parseInt(attribs.slice(start, index), 36));
      }
      if (attribs[index] !== '+') break;
      index += 1;
      const start = index;
      while (index < attribs.length && /[0-9a-z]/i.test(attribs[index])) index += 1;
      const length = parseInt(attribs.slice(start, index), 36);
      if (!Number.isFinite(length) || length <= 0) continue;
      runs.push({ start: cursor, end: Math.min(cursor + length, textLength), attributes });
      cursor += length;
    }
    if (!runs.length && textLength) runs.push({ start: 0, end: textLength, attributes: [] });
    return runs;
  }

  function isBold(attributes, pool) {
    return attributes.some((id) => {
      const attribute = pool.get(id);
      if (!attribute || attribute.key !== 'b') return false;
      return attribute.value === '1' || (Array.isArray(attribute.value) && attribute.value.includes('1'));
    });
  }

  function formattedBlockText(block, pool) {
    const raw = block && block.props && block.props.title && block.props.title.text;
    const text = normalizeText(raw);
    if (!text) return '';
    const attribs = block && block.props && block.props.title && block.props.title.attribs;
    const runs = decodeAttributeRuns(attribs, String(raw || '').length);
    const pieces = [];
    runs.forEach((run) => {
      const value = escapeInline(String(raw || '').slice(run.start, run.end));
      if (!value) return;
      const bold = isBold(run.attributes, pool);
      const previous = pieces[pieces.length - 1];
      if (previous && previous.bold === bold) {
        previous.value += value;
      } else {
        pieces.push({ bold, value });
      }
    });
    return pieces.map((piece) => piece.bold ? `**${piece.value}**` : piece.value).join('') || escapeInline(text);
  }

  function renderMarkdown(documentData) {
    const byId = new Map(documentData.blocks.map((block) => [block.id, block]));
    const attributePool = parseAttributePool(documentData.apool);
    const page = byId.get(documentData.pageId) || documentData.blocks.find((block) => block.type === TYPE.PAGE);
    if (!page || !Array.isArray(page.children)) throw new Error('未找到当前页面的区块顺序');

    function descendantText(id, formatted = false) {
      const block = byId.get(id);
      if (!block) return '';
      const own = formatted ? formattedBlockText(block, attributePool) : blockText(block);
      if (own) return own;
      return (block.children || []).map((childId) => descendantText(childId, formatted)).filter(Boolean).join('\n');
    }

    function renderTable(table) {
      const rows = (table.children || [])
        .map((rowId) => byId.get(rowId))
        .filter((row) => row && row.type === TYPE.TABLE_ROW)
        .map((row) => (row.children || []).map((cellId) => escapeTableCell(descendantText(cellId, true))));
      if (!rows.length) return '';

      const width = Math.max(...rows.map((row) => row.length));
      const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
      const header = normalized[0];
      const separator = Array(width).fill('---');
      return [header, separator, ...normalized.slice(1)]
        .map((row) => `| ${row.join(' | ')} |`)
        .join('\n');
    }

    function renderBlock(block) {
      const text = formattedBlockText(block, attributePool);
      switch (block.type) {
        case TYPE.TEXT:
          return text;
        case TYPE.ORDERED_LIST:
          return text ? `1. ${text}` : '';
        case TYPE.BULLETED_LIST:
          return text ? `- ${text}` : '';
        case TYPE.DIVIDER:
          return '---';
        case TYPE.HEADER_1:
          return text ? `# ${text}` : '';
        case TYPE.HEADER_2:
          return text ? `## ${text}` : '';
        case TYPE.HEADER_3:
          return text ? `### ${text}` : '';
        case TYPE.TABLE:
          return renderTable(block);
        case TYPE.QUOTE: {
          const quote = (block.children || []).map((id) => descendantText(id, true)).filter(Boolean).join('\n');
          return quote.split('\n').map((line) => `> ${line}`).join('\n');
        }
        default:
          return text;
      }
    }

    const sections = page.children
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map(renderBlock)
      .filter(Boolean);

    return `${sections.join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`;
  }

  function safeFilename(name) {
    return normalizeText(name).replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '') || '企业微信文档';
  }

  function downloadMarkdown(markdown, title) {
    const blob = new Blob(['\ufeff', markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFilename(title)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createButton() {
    if (document.getElementById('wx-smartpage-export-md')) return;
    const button = document.createElement('button');
    button.id = 'wx-smartpage-export-md';
    button.type = 'button';
    button.textContent = '导出 Markdown';
    button.title = '下载当前页面的完整 Markdown 文档';
    Object.assign(button.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483647',
      padding: '10px 16px',
      border: '1px solid rgba(0, 0, 0, 0.12)',
      borderRadius: '6px',
      background: '#1677ff',
      color: '#fff',
      font: '14px/20px system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.16)',
    });

    button.addEventListener('click', async () => {
      if (state.exporting) return;
      state.exporting = true;
      button.disabled = true;
      const original = button.textContent;
      try {
        const data = await loadDocument((text) => { button.textContent = text; });
        button.textContent = '正在生成 Markdown...';
        const markdown = renderMarkdown(data);
        downloadMarkdown(markdown, data.title);
        button.textContent = '导出完成';
      } catch (error) {
        console.error('[Markdown Export]', error);
        button.textContent = '导出失败';
        alert(`Markdown 导出失败：${error.message || error}`);
      } finally {
        setTimeout(() => {
          button.textContent = original;
          button.disabled = false;
          state.exporting = false;
        }, 1800);
      }
    });

    document.body.appendChild(button);
  }

  createButton();
  new MutationObserver(createButton).observe(document.documentElement, { childList: true, subtree: true });
})();
