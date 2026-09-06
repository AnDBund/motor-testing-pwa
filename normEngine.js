const LEVEL_ORDER = ["добрий", "середній", "задовільний"];

function normalizeGender(gender) {
  return String(gender || '').trim().toLowerCase();
}

function normalizeId(value) {
  return String(value || '').trim();
}

export function buildTestLabel(testId) {
  const safeValue = normalizeId(testId).replace(/[_-]+/g, ' ');
  return safeValue
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function parseNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateNorm(testId, gender, rawValue, norms = []) {
  const value = parseNumeric(rawValue);
  const normalizedTestId = normalizeId(testId);
  const normalizedGender = normalizeGender(gender);

  if (!normalizedTestId) {
    return {
      ok: false,
      error: 'Не вказано ідентифікатор тесту.',
      level: null,
      levelNameUi: null,
      range: null,
    };
  }

  if (value === null) {
    return {
      ok: false,
      error: 'Результат має бути числовим значенням.',
      level: null,
      levelNameUi: null,
      range: null,
    };
  }

  const matchingRules = norms.filter((rule) => {
    const ruleTestId = normalizeId(rule.test_id);
    const ruleGender = normalizeGender(rule.gender);

    return ruleTestId === normalizedTestId && ruleGender === normalizedGender;
  });

  if (!matchingRules.length) {
    return {
      ok: false,
      error: `Для тесту "${buildTestLabel(normalizedTestId)}" та статі "${normalizedGender || 'не вказано'}" норматив не знайдено.`,
      level: null,
      levelNameUi: null,
      range: null,
    };
  }

  const matchedRule = matchingRules.find((rule) => {
    const min = Number(rule.min_result);
    const max = Number(rule.max_result);
    return Number.isFinite(min) && Number.isFinite(max) && value >= min && value <= max;
  });

  if (!matchedRule) {
    return {
      ok: false,
      error: 'Результат не потрапив у жоден з діапазонів нормативу.',
      level: null,
      levelNameUi: null,
      range: null,
    };
  }

  const levelNameUi = String(matchedRule.level_name_ui || '').trim() || 'невідомий';
  const levelIndex = LEVEL_ORDER.indexOf(levelNameUi);

  return {
    ok: true,
    error: null,
    level: levelIndex >= 0 ? levelIndex : 0,
    levelNameUi,
    range: {
      min: Number(matchedRule.min_result),
      max: Number(matchedRule.max_result),
    },
    value,
    testId: normalizedTestId,
  };
}

export function extractUniqueTestIds(norms = []) {
  const ids = new Set();

  norms.forEach((rule) => {
    if (rule && rule.test_id) {
      ids.add(String(rule.test_id).trim());
    }
  });

  return [...ids].sort();
}

export function getLevelClass(levelNameUi) {
  const level = String(levelNameUi || '').trim().toLowerCase();

  if (level === 'добрий') {
    return 'good';
  }

  if (level === 'середній') {
    return 'medium';
  }

  if (level === 'задовільний') {
    return 'weak';
  }

  return '';
}
