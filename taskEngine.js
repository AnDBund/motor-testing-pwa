export async function loadJson(url) {
  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Не вдалося завантажити ${url}: ${response.status}`);
  }

  return response.json();
}

export async function loadTestsCatalog() {
  // Prefer the authoritative test_passport.json to preserve full metadata,
  // but fall back to a simpler tests_catalog.json if present.
  const candidates = ['./data/test_passport.json', 'data/test_passport.json', './data/tests_catalog.json', 'data/tests_catalog.json'];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) continue;

      const data = await resp.json();

      // If this is already a catalog (has title), return as-is
      if (Array.isArray(data) && data.length && data[0].title) {
        return data;
      }

      // If structure looks like test_passport entries, map to catalog but keep full metadata
      if (Array.isArray(data) && data.length && data[0].test_name_ui) {
        return data.map((item) => ({
          test_id: item.test_id,
          title: item.test_name_ui || item.test_id,
          category: item.quality_category || item.category || '',
          // preserve original fields under canonical keys so UI can show full info
          inventory: item.inventory || item.recommended_equipment || '',
          performance_technique: item.performance_technique || item.description || '',
          result_recording: item.result_recording || item.result_record || '',
          metrics: item.metrics || item.unit || '',
          video_example: item.video_example || item.reference || null,
        }));
      }
    } catch (e) {
      // continue to next candidate
    }
  }

  return [];
}

export async function resolveDataUrls(primaryUrls, fallbackUrls = []) {
  const candidates = [...primaryUrls, ...fallbackUrls];

  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        return url;
      }
    } catch (error) {
      // Ignoring missing files and continuing to the next candidate.
    }
  }

  return candidates[0] || '';
}

export function getTaskCatalog(taskGuide = []) {
  return taskGuide.map((task) => ({
    task_id: task.task_id,
    task_name_ui: task.task_name_ui,
    task_description: task.task_description,
    quiz_question: task.quiz_question,
    next_task_id: task.next_task_id,
  }));
}

export function getTaskById(taskGuide = [], taskId) {
  return taskGuide.find((task) => task.task_id === taskId) || null;
}
